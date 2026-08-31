import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
const LOCAL_CHAIN_ID = 31337;
const V3_FEE_TIER = 3000;
const TEST_GRADUATION_TARGET_USD = ethers.parseEther("6");
const EXPECTED_FACTORY_GENERATION = 4n;
const EXPECTED_CAMPAIGN_GENERATION = 3n;
const EXPECTED_LIQUIDITY_KIND = 2n;
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

function sameAddress(a: string, b: string): boolean {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function assertEq(label: string, actual: bigint, expected: bigint): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const allowLocal = truthy(process.env.ALLOW_LOCAL_RH_PROTOCOL_STAGE);
  if (chainId !== ROBINHOOD_TESTNET_CHAIN_ID && !(allowLocal && chainId === LOCAL_CHAIN_ID)) {
    throw new Error(
      `Robinhood staged protocol deployment is restricted to chain ${ROBINHOOD_TESTNET_CHAIN_ID}` +
        `${allowLocal ? ` or local ${LOCAL_CHAIN_ID}` : ""}; connected chain is ${chainId}.`,
    );
  }

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const admin = envAddress("ROBINHOOD_TESTNET_ADMIN", deployerAddress);
  const routeAuthority = envAddress("ROBINHOOD_ROUTE_AUTHORITY_ADDRESS", deployerAddress);
  if (!sameAddress(admin, deployerAddress)) {
    throw new Error(
      `Staged deployer must control ROBINHOOD_TESTNET_ADMIN so the stack can be wired atomically. ` +
        `deployer=${deployerAddress} admin=${admin}`,
    );
  }

  const deploymentBlock = await ethers.provider.getBlockNumber();
  const testNativeUsdPrice = String(process.env.ROBINHOOD_TEST_NATIVE_USD_PRICE || DEFAULT_TEST_NATIVE_USD_PRICE).trim();
  const parsedTestPrice = ethers.parseUnits(testNativeUsdPrice, 8);
  if (parsedTestPrice <= 0n) throw new Error("ROBINHOOD_TEST_NATIVE_USD_PRICE must be positive");

  console.log("[robinhood-stage] deploying isolated staging protocol", {
    network: network.name,
    chainId,
    deployer: deployerAddress,
    routeAuthority,
    testNativeUsdPrice,
  });

  const WETH = await ethers.getContractFactory("MockWETH9");
  const weth = await WETH.deploy();
  await weth.waitForDeployment();

  const V3Factory = await ethers.getContractFactory("MockUniswapV3Factory");
  const v3Factory = await V3Factory.deploy();
  await v3Factory.waitForDeployment();

  const PositionManager = await ethers.getContractFactory("MockUniswapV3PositionManager");
  const positionManager = await PositionManager.deploy(await v3Factory.getAddress(), await weth.getAddress());
  await positionManager.waitForDeployment();

  const SwapRouter = await ethers.getContractFactory("MockUniswapV3SwapRouter");
  const swapRouter = await SwapRouter.deploy(await v3Factory.getAddress(), await weth.getAddress());
  await swapRouter.waitForDeployment();
  await (await v3Factory.configurePeriphery(await positionManager.getAddress(), await swapRouter.getAddress())).wait();

  const Adapter = await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter");
  const adapter = await Adapter.deploy(
    await v3Factory.getAddress(),
    await positionManager.getAddress(),
    await weth.getAddress(),
    V3_FEE_TIER,
  );
  await adapter.waitForDeployment();

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
    await adapter.getAddress(),
    await treasuryRouter.getAddress(),
    await campaignImplementation.getAddress(),
    await graduationOracle.getAddress(),
  );
  await launchFactory.waitForDeployment();

  const lockerAddress = await launchFactory.permanentLpLocker();
  const v3Locker = await ethers.getContractAt("PermanentV3PositionLocker", lockerAddress);

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
    mockWeth9: await weth.getAddress(),
    mockV3Factory: await v3Factory.getAddress(),
    mockNonfungiblePositionManager: await positionManager.getAddress(),
    mockSwapRouter02: await swapRouter.getAddress(),
    graduationAdapter: await adapter.getAddress(),
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
    permanentV3PositionLocker: lockerAddress,
  };

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
  if (!(await launchFactory.requireRouteAuthorization())) throw new Error("Route authorization must remain required");
  if (!(await launchFactory.requireAuthorizedTrading())) throw new Error("Authorized trading must remain required");
  if ((await launchFactory.config()).graduationTarget !== TEST_GRADUATION_TARGET_USD) {
    throw new Error("$6 test graduation threshold was not configured");
  }
  if (!(await creatorRegistry.launchRecorder(await launchFactory.getAddress()))) {
    throw new Error("CreatorRegistry does not authorize the staged LaunchFactory");
  }
  if (!(await treasuryRouter.authorizedLpLocker(lockerAddress))) {
    throw new Error("TreasuryRouterV3 does not authorize the staged V3 locker");
  }
  if (!sameAddress(await treasuryRouter.permanentLpLocker(), lockerAddress)) {
    throw new Error("TreasuryRouterV3 primary locker mismatch");
  }
  if (!sameAddress(await v3Locker.integrationSource(), await adapter.getAddress())) {
    throw new Error("V3 locker graduation-adapter wiring mismatch");
  }
  if (!sameAddress(await v3Locker.positionManager(), await positionManager.getAddress())) {
    throw new Error("V3 locker position manager mismatch");
  }
  if (!sameAddress(await v3Locker.v3Factory(), await v3Factory.getAddress())) {
    throw new Error("V3 locker factory mismatch");
  }
  if (!sameAddress(await v3Locker.wrappedNative(), await weth.getAddress())) {
    throw new Error("V3 locker wrapped-native mismatch");
  }
  if (!sameAddress(await communityRewardsVault.router(), await treasuryRouter.getAddress())) {
    throw new Error("CommunityRewardsVault router mismatch");
  }
  if (!sameAddress(await creatorRewardsVault.router(), await treasuryRouter.getAddress())) {
    throw new Error("CreatorRewardsVault router mismatch");
  }

  const standardTrade = await treasuryRouter.previewTrade(10_000n, 0);
  assertEq("standard trade league", standardTrade.league, 3_750n);
  assertEq("standard trade creator", standardTrade.creator, 500n);
  assertEq("standard trade recruiter", standardTrade.recruiter, 1_250n);
  assertEq("standard trade squad", standardTrade.squad, 250n);
  assertEq("standard trade protocol", standardTrade.protocol, 4_250n);

  const ogTrade = await treasuryRouter.previewTrade(10_000n, 2);
  assertEq("og trade creator", ogTrade.creator, 500n);
  assertEq("og trade recruiter", ogTrade.recruiter, 1_500n);
  assertEq("og trade protocol", ogTrade.protocol, 4_000n);

  const unlinkedTrade = await treasuryRouter.previewTrade(10_000n, 1);
  assertEq("unlinked trade creator", unlinkedTrade.creator, 500n);
  assertEq("unlinked trade airdrop", unlinkedTrade.airdrop, 1_500n);
  assertEq("unlinked trade protocol", unlinkedTrade.protocol, 4_250n);

  const manifest = {
    schemaVersion: 3,
    chainKey: "robinhood-testnet",
    targetChainId: ROBINHOOD_TESTNET_CHAIN_ID,
    chainId,
    network: network.name,
    environment: chainId === ROBINHOOD_TESTNET_CHAIN_ID ? "staging" : "local-rehearsal",
    deployedAt: new Date().toISOString(),
    deploymentBlock,
    factoryGeneration: Number(factoryGeneration),
    campaignGeneration: Number(campaignGeneration),
    liquidityKind: Number(liquidityKind),
    graduationTargetUsd: TEST_GRADUATION_TARGET_USD.toString(),
    testNativeUsdPrice,
    v3FeeTier: V3_FEE_TIER,
    supportEnabled: false,
    creationEnabled: false,
    factoryLive: false,
    securityDefaultsLocked: true,
    routeAuthority,
    admin,
    contracts,
    stagingOnly: {
      controlledV3Dex: true,
      mockNativeUsdPriceFeed: true,
      productionCompatible: false,
      correctedFeeModel: true,
    },
    activationPrerequisites: [
      "verify all contract bytecode and immutable wiring",
      "fund test wallets with Robinhood testnet ETH",
      "configure frontend/API route-authority signer for factory 4 / campaign 3 on chain 46630",
      "prove treasury router v3 Standard, OG and Unlinked parity previews",
      "run scheduled-create, launchAt, native V3 buy/sell, $6 graduation, locked NFT, 80/20 harvest",
      "run creator fee claim proof against the corrected fee model",
      "only then call LaunchFactory.enableLive() and setCreatePaused(false) for testnet acceptance",
      "pause creation again with setCreatePaused(true) after the acceptance run",
    ],
    note: "Robinhood testnet staging only. Mock V3 and price-feed addresses must never be promoted to mainnet.",
  };

  const explicitOut = String(process.env.ROBINHOOD_STAGE_DEPLOYMENT_FILE || "").trim();
  const outFile = explicitOut
    ? path.resolve(explicitOut)
    : chainId === ROBINHOOD_TESTNET_CHAIN_ID
      ? path.resolve("deployments/robinhood/testnet.staged.json")
      : path.resolve(".tmp/robinhood-testnet-stage.local.json");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log("[robinhood-stage] staged protocol self-verification passed");
  console.log(`[robinhood-stage] manifest=${outFile}`);
  console.log(`[robinhood-stage] FACTORY_ADDRESS_46630=${contracts.launchFactory}`);
  console.log(`[robinhood-stage] FACTORY_START_BLOCK_46630=${deploymentBlock}`);
  console.log(`[robinhood-stage] SUPPORTED_FACTORY_ADDRESSES_46630=${contracts.launchFactory}`);
  console.log(`[robinhood-stage] SUPPORTED_FACTORY_START_BLOCKS_46630=${deploymentBlock}`);
  console.log("[robinhood-stage] creation remains DISABLED until explicit testnet activation");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
