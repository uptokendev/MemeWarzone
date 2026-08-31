import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { allowBnb6cTestnetSourceHeadBroadcast } from "./lib/bnbLiveGenerationGuard";
import {
  LIVE_97_FACTORY,
  LIVE_97_TREASURY_V2,
  LIVE_TOPAZ_FACTORY,
  assertNewStackAvoidsLiveAddresses,
  snapshotLiveBnbTestnetFactory,
} from "./lib/bnbLiveFactorySnapshot";
import { LIVE_97_ROUTE_AUTHORITY, resolveBnb6cRouteAuthority, sameAddress } from "./bnb6cRouteAuthority";

const BNB_TESTNET_CHAIN_ID = 97;
const LOCAL_CHAIN_ID = 31337;
const EXPECTED_FACTORY_GENERATION = 4n;
const EXPECTED_CAMPAIGN_GENERATION = 3n;
const EXPECTED_LIQUIDITY_KIND = 1n;
const REQUIRED_POOL_FEE_BPS = 30n;
const TEST_GRADUATION_TARGET_USD = ethers.parseEther("6");
const TREASURY_UPGRADE_DELAY = 3600;
const DEFAULT_TEST_NATIVE_USD_PRICE = "3000";

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function envAddress(name: string, fallback: string): string {
  const raw = String(process.env[name] || fallback).trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero address; got ${raw || "<empty>"}`);
  }
  return ethers.getAddress(raw);
}

async function requireCode(address: string, label: string): Promise<void> {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no bytecode at ${address}`);
}

function assertEq(label: string, actual: bigint, expected: bigint): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function probeLiveTopazFeeBps(): Promise<number | null> {
  const code = await ethers.provider.getCode(LIVE_TOPAZ_FACTORY);
  if (!code || code === "0x") return null;
  const topaz = new ethers.Contract(LIVE_TOPAZ_FACTORY, ["function getFee(address,bool) view returns (uint256)"], ethers.provider);
  return Number(await topaz.getFee(ethers.ZeroAddress, false));
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  allowBnb6cTestnetSourceHeadBroadcast(chainId);
  if (chainId === BNB_TESTNET_CHAIN_ID) {
    throw new Error("6C first cut is local rehearsal only. Refusing chain-97 broadcast until the rehearsal SHA is audited.");
  }

  const [deployer, localAuthority] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const admin = envAddress("BNB_TESTNET_ADMIN", deployerAddress);
  if (!sameAddress(admin, deployerAddress)) {
    throw new Error(`Staged deployer must control BNB_TESTNET_ADMIN. deployer=${deployerAddress} admin=${admin}`);
  }

  let routeAuthority = "";
  try {
    routeAuthority = resolveBnb6cRouteAuthority({ chainId, deployerAddress }).address;
  } catch (error) {
    if (chainId === LOCAL_CHAIN_ID && localAuthority) {
      routeAuthority = ethers.getAddress(await localAuthority.getAddress());
      if (sameAddress(routeAuthority, deployerAddress) || sameAddress(routeAuthority, LIVE_97_ROUTE_AUTHORITY)) {
        throw error;
      }
    } else {
      throw error;
    }
  }

  const liveBefore = await snapshotLiveBnbTestnetFactory(ethers.provider);
  const liveTopazFeeBps = chainId === BNB_TESTNET_CHAIN_ID ? await probeLiveTopazFeeBps() : null;
  if (chainId === BNB_TESTNET_CHAIN_ID) {
    if (liveBefore.factoryGeneration !== "3" || liveBefore.campaignGeneration !== "2") {
      throw new Error(`Gate 0: live 97 factory is ${liveBefore.factoryGeneration}/${liveBefore.campaignGeneration}, expected 3/2`);
    }
    if (liveTopazFeeBps !== 100 && liveTopazFeeBps !== 30 && liveTopazFeeBps !== null) {
      throw new Error(`Gate 0: unexpected live Topaz fee ${liveTopazFeeBps}`);
    }
    if (liveTopazFeeBps !== 30 && !truthy(process.env.BNB_6C_ACK_CONTROLLED_TOPAZ)) {
      throw new Error("Gate 0: live Topaz is not 30 bps. Set BNB_6C_ACK_CONTROLLED_TOPAZ=true to deploy an isolated 30 bps Topaz-compatible mock.");
    }
  }

  const testNativeUsdPrice = String(process.env.BNB_6C_TEST_NATIVE_USD_PRICE || DEFAULT_TEST_NATIVE_USD_PRICE).trim();
  const parsedTestPrice = ethers.parseUnits(testNativeUsdPrice, 8);
  if (parsedTestPrice <= 0n) throw new Error("BNB_6C_TEST_NATIVE_USD_PRICE must be positive");
  const deploymentBlock = await ethers.provider.getBlockNumber();

  console.log("[bnb-6c-stage] deploying isolated 4/3 staging protocol", {
    network: network.name,
    chainId,
    deployer: deployerAddress,
    routeAuthority,
    liveTopazFeeBps,
    controlledTopaz: true,
  });

  const WBNB = await ethers.getContractFactory("MockWBNB");
  const wbnb = await WBNB.deploy();
  await wbnb.waitForDeployment();

  const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
  const topazFactory = await TopazFactory.deploy();
  await topazFactory.waitForDeployment();
  if ((await topazFactory.feeBps()) !== REQUIRED_POOL_FEE_BPS) {
    throw new Error(`Controlled Topaz mock fee is ${await topazFactory.feeBps()}, required ${REQUIRED_POOL_FEE_BPS}`);
  }

  const Router = await ethers.getContractFactory("MockTopazRouter");
  const router = await Router.deploy(await topazFactory.getAddress(), await wbnb.getAddress());
  await router.waitForDeployment();

  const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
  const priceFeed = await PriceFeed.deploy(8);
  await priceFeed.waitForDeployment();
  const latest = await ethers.provider.getBlock("latest");
  const timestamp = BigInt(latest!.timestamp);
  await (await priceFeed.setRoundData(1n, parsedTestPrice, timestamp, timestamp, 1n)).wait();

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const graduationOracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 30 * 24 * 60 * 60);
  await graduationOracle.waitForDeployment();

  const WeeklyVault = await ethers.getContractFactory("TreasuryVaultV2");
  const weeklyLeagueVault = await WeeklyVault.deploy(admin, ethers.ZeroAddress, admin);
  await weeklyLeagueVault.waitForDeployment();

  const Charity = await ethers.getContractFactory("CharityTreasury");
  const charityTreasury = await Charity.deploy(admin);
  await charityTreasury.waitForDeployment();

  const Monthly = await ethers.getContractFactory("MonthlyLeagueTreasury");
  const monthlyLeagueTreasury = await Monthly.deploy(
    admin,
    admin,
    await graduationOracle.getAddress(),
    await charityTreasury.getAddress(),
    1_500_000n * 10n ** 18n,
  );
  await monthlyLeagueTreasury.waitForDeployment();

  const Recruiter = await ethers.getContractFactory("RecruiterRewardsVault");
  const recruiterRewardsVault = await Recruiter.deploy(admin);
  await recruiterRewardsVault.waitForDeployment();

  const Protocol = await ethers.getContractFactory("ProtocolRevenueVault");
  const protocolRevenueVault = await Protocol.deploy(admin);
  await protocolRevenueVault.waitForDeployment();

  const Treasury = await ethers.getContractFactory("TreasuryRouterV3");
  const treasuryRouter = await Treasury.deploy(
    admin,
    await weeklyLeagueVault.getAddress(),
    await monthlyLeagueTreasury.getAddress(),
    TREASURY_UPGRADE_DELAY,
  );
  await treasuryRouter.waitForDeployment();

  const Community = await ethers.getContractFactory("CommunityRewardsVault");
  const communityRewardsVault = await Community.deploy(admin, await treasuryRouter.getAddress());
  await communityRewardsVault.waitForDeployment();

  const CreatorRewards = await ethers.getContractFactory("CreatorRewardsVault");
  const creatorRewardsVault = await CreatorRewards.deploy(admin, await treasuryRouter.getAddress());
  await creatorRewardsVault.waitForDeployment();

  await (await treasuryRouter.setRecruiterRewardsVault(await recruiterRewardsVault.getAddress())).wait();
  await (await treasuryRouter.setCommunityRewardsVault(await communityRewardsVault.getAddress())).wait();
  await (await treasuryRouter.setProtocolRevenueVault(await protocolRevenueVault.getAddress())).wait();
  await (await treasuryRouter.setCreatorRewardsVault(await creatorRewardsVault.getAddress())).wait();

  const CreatorRegistry = await ethers.getContractFactory("CreatorRegistry");
  const creatorRegistry = await CreatorRegistry.deploy();
  await creatorRegistry.waitForDeployment();

  const RiskRegistry = await ethers.getContractFactory("RiskRegistry");
  const riskRegistry = await RiskRegistry.deploy();
  await riskRegistry.waitForDeployment();

  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const campaignImplementation = await Campaign.deploy();
  await campaignImplementation.waitForDeployment();

  const LaunchFactory = await ethers.getContractFactory("LaunchFactory");
  const launchFactory = await LaunchFactory.deploy(
    await router.getAddress(),
    await treasuryRouter.getAddress(),
    await campaignImplementation.getAddress(),
    await graduationOracle.getAddress(),
  );
  await launchFactory.waitForDeployment();

  const lockerAddress = await launchFactory.permanentLpLocker();
  const locker = await ethers.getContractAt("PermanentLpLocker", lockerAddress);
  await (await router.setFeeCollector(lockerAddress)).wait();

  const currentConfig = await launchFactory.config();
  await (
    await launchFactory.setConfig({
      totalSupply: currentConfig.totalSupply,
      curveBps: currentConfig.curveBps,
      liquidityTokenBps: currentConfig.liquidityTokenBps,
      basePrice: currentConfig.basePrice,
      priceSlope: currentConfig.priceSlope,
      graduationTarget: TEST_GRADUATION_TARGET_USD,
      liquidityBps: currentConfig.liquidityBps,
    })
  ).wait();
  await (await launchFactory.setRegistries(await creatorRegistry.getAddress(), await riskRegistry.getAddress())).wait();
  await (await launchFactory.setRouteAuthority(routeAuthority)).wait();
  await (await launchFactory.setRouteProfiles(1, 1)).wait();
  await (await launchFactory.setProtocolFee(200)).wait();
  await (await creatorRegistry.setLaunchRecorder(await launchFactory.getAddress(), true)).wait();
  await (await treasuryRouter.setAuthorizedLpLocker(lockerAddress, true)).wait();
  await (await treasuryRouter.setPrimaryLpLocker(lockerAddress)).wait();
  await (await launchFactory.lockSecurityDefaults()).wait();
  await (await launchFactory.setCreatePaused(true)).wait();

  const contracts = {
    mockWbnb: await wbnb.getAddress(),
    mockTopazFactory: await topazFactory.getAddress(),
    mockTopazRouter: await router.getAddress(),
    mockNativeUsdPriceFeed: await priceFeed.getAddress(),
    graduationOracle: await graduationOracle.getAddress(),
    weeklyLeagueVault: await weeklyLeagueVault.getAddress(),
    charityTreasury: await charityTreasury.getAddress(),
    monthlyLeagueTreasury: await monthlyLeagueTreasury.getAddress(),
    recruiterRewardsVault: await recruiterRewardsVault.getAddress(),
    protocolRevenueVault: await protocolRevenueVault.getAddress(),
    treasuryRouterV3: await treasuryRouter.getAddress(),
    communityRewardsVault: await communityRewardsVault.getAddress(),
    creatorRewardsVault: await creatorRewardsVault.getAddress(),
    creatorRegistry: await creatorRegistry.getAddress(),
    riskRegistry: await riskRegistry.getAddress(),
    launchCampaignImplementation: await campaignImplementation.getAddress(),
    launchFactory: await launchFactory.getAddress(),
    permanentLpLocker: lockerAddress,
  };

  assertNewStackAvoidsLiveAddresses(Object.values(contracts));
  await Promise.all(Object.entries(contracts).map(([label, address]) => requireCode(address, label)));

  const [factoryGeneration, campaignGeneration, liquidityKind, factoryLive, securityLocked, createPaused] = await Promise.all([
    launchFactory.FACTORY_GENERATION(),
    launchFactory.CAMPAIGN_GENERATION(),
    launchFactory.liquidityKind(),
    launchFactory.live(),
    launchFactory.securityDefaultsLocked(),
    launchFactory.createPaused(),
  ]);
  if (factoryGeneration !== EXPECTED_FACTORY_GENERATION) throw new Error(`Factory generation mismatch: ${factoryGeneration}`);
  if (campaignGeneration !== EXPECTED_CAMPAIGN_GENERATION) throw new Error(`Campaign generation mismatch: ${campaignGeneration}`);
  if (liquidityKind !== EXPECTED_LIQUIDITY_KIND) throw new Error(`Liquidity kind mismatch: ${liquidityKind}`);
  if (factoryLive) throw new Error("Staged LaunchFactory unexpectedly became live");
  if (!securityLocked) throw new Error("LaunchFactory security defaults are not locked");
  if (!createPaused) throw new Error("Staged LaunchFactory must keep createPaused=true until explicit acceptance");
  if ((await locker.REQUIRED_POOL_FEE_BPS()) !== REQUIRED_POOL_FEE_BPS) throw new Error("Locker required pool fee is not 30 bps");
  if ((await topazFactory.feeBps()) !== REQUIRED_POOL_FEE_BPS) throw new Error("Controlled Topaz factory is not 30 bps");
  if (!(await treasuryRouter.authorizedLpLocker(lockerAddress))) throw new Error("TreasuryRouterV3 does not authorize the staged locker");
  if (!sameAddress(await creatorRewardsVault.router(), await treasuryRouter.getAddress())) throw new Error("CreatorRewardsVault router mismatch");
  if (sameAddress(await treasuryRouter.getAddress(), LIVE_97_TREASURY_V2)) throw new Error("6C reused live V2 treasury");
  if (sameAddress(await launchFactory.getAddress(), LIVE_97_FACTORY)) throw new Error("6C reused live 3/2 factory");

  const standardTrade = await treasuryRouter.previewTrade(10_000n, 0);
  assertEq("standard trade creator", standardTrade.creator, 500n);
  assertEq("standard trade recruiter", standardTrade.recruiter, 1_250n);
  const ogTrade = await treasuryRouter.previewTrade(10_000n, 2);
  assertEq("og trade creator", ogTrade.creator, 500n);
  assertEq("og trade recruiter", ogTrade.recruiter, 1_500n);
  const unlinkedTrade = await treasuryRouter.previewTrade(10_000n, 1);
  assertEq("unlinked trade creator", unlinkedTrade.creator, 500n);
  assertEq("unlinked trade airdrop", unlinkedTrade.airdrop, 1_500n);
  const finalize = await treasuryRouter.previewFinalize(10_000n, 1);
  assertEq("finalize creator", finalize.creator, 0n);

  const liveAfter = await snapshotLiveBnbTestnetFactory(ethers.provider);
  if (JSON.stringify(liveBefore) !== JSON.stringify(liveAfter)) {
    throw new Error("live 3/2 factory snapshot changed during 6C staged deploy");
  }

  const manifest = {
    schemaVersion: 1,
    kind: "bnb-testnet-stage",
    chainKey: "bnb-testnet",
    targetChainId: BNB_TESTNET_CHAIN_ID,
    chainId,
    network: network.name,
    environment: chainId === BNB_TESTNET_CHAIN_ID ? "staging" : "local-rehearsal",
    deployedAt: new Date().toISOString(),
    deploymentBlock,
    factoryGeneration: Number(factoryGeneration),
    campaignGeneration: Number(campaignGeneration),
    liquidityKind: Number(liquidityKind),
    requiredPoolFeeBps: 30,
    graduationTargetUsd: TEST_GRADUATION_TARGET_USD.toString(),
    testNativeUsdPrice,
    supportEnabled: false,
    creationEnabled: false,
    factoryLive: false,
    securityDefaultsLocked: true,
    routeAuthority,
    admin,
    contracts,
    stagingOnly: {
      controlledTopazDex: true,
      wrappedWithTopazRouterAdapter: false,
      mockNativeUsdPriceFeed: true,
      productionCompatible: false,
      realTopazCompatibility: false,
      uniswapV3Rejected: true,
    },
    liveBnbUntouched: {
      factory: LIVE_97_FACTORY,
      generation: "3/2",
      treasuryRouterV2: LIVE_97_TREASURY_V2,
      snapshot: liveAfter,
      liveTopazFeeBps,
    },
    note: "Isolated BNB 4/3 protocol staging. Controlled 30 bps Topaz-compatible mock does not certify real Topaz production compatibility.",
  };

  const explicitOut = String(process.env.BNB_6C_STAGE_DEPLOYMENT_FILE || "").trim();
  const outFile = explicitOut
    ? path.resolve(explicitOut)
    : chainId === BNB_TESTNET_CHAIN_ID
      ? path.resolve("deployments/bnb/testnet.staged.json")
      : path.resolve(".tmp/bnb-testnet-stage.local.json");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log("[bnb-6c-stage] staged protocol self-verification passed");
  console.log(`[bnb-6c-stage] manifest=${outFile}`);
  console.log(`[bnb-6c-stage] launchFactory=${contracts.launchFactory}`);
  console.log("[bnb-6c-stage] live=false createPaused=true; real Topaz compatibility remains a later gate");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
