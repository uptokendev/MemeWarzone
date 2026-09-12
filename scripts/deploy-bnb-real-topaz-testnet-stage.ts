import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { allowBnb6cTestnetSourceHeadBroadcast } from "./lib/bnbLiveGenerationGuard";
import {
  LIVE_97_FACTORY,
  LIVE_97_TREASURY_V2,
  assertNewStackAvoidsLiveAddresses,
  snapshotLiveBnbTestnetFactory,
} from "./lib/bnbLiveFactorySnapshot";
import { LIVE_97_ROUTE_AUTHORITY, resolveBnb6cRouteAuthority, sameAddress } from "./bnb6cRouteAuthority";

const {
  TOPAZ_DEPLOYMENT_AUTHORITY,
  loadAuthoritativeTopazManifest,
  assertRuntimeTopazIdentity,
} = require("./lib/bnbRealTopazAuthority.cjs");
const { resolveExactCheckedOutHead } = require("./lib/exactSourceHead.cjs");

const BNB_TESTNET_CHAIN_ID = 97;
const EXPECTED_FACTORY_GENERATION = 4n;
const EXPECTED_CAMPAIGN_GENERATION = 3n;
const EXPECTED_LIQUIDITY_KIND = 1n;
const REQUIRED_POOL_FEE_BPS = 30n;
const TEST_GRADUATION_TARGET_USD = ethers.parseEther("6");
const TREASURY_UPGRADE_DELAY = 3600;
const DEFAULT_TEST_NATIVE_USD_PRICE = "3000";

function envAddress(name: string, fallback: string): string {
  const raw = String(process.env[name] || fallback).trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) throw new Error(`${name} must be a non-zero address`);
  return ethers.getAddress(raw);
}

async function requireCode(address: string, label: string): Promise<void> {
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`${label} has no bytecode at ${address}`);
}

function eq(label: string, actual: unknown, expected: unknown): void {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

async function deploymentEvidence(contract: any, label: string) {
  const tx = contract.deploymentTransaction();
  if (!tx) throw new Error(`${label} deployment transaction is unavailable`);
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`${label} deployment receipt is unavailable`);
  return {
    address: await contract.getAddress(),
    txHash: tx.hash,
    receiptBlock: receipt.blockNumber,
  };
}

async function main() {
  const sourceBaseSha = resolveExactCheckedOutHead(process.cwd());
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  allowBnb6cTestnetSourceHeadBroadcast(chainId);
  if (chainId !== BNB_TESTNET_CHAIN_ID || network.name !== "bscTestnet") {
    throw new Error(`real Topaz staging requires bscTestnet chain 97, got ${network.name}/${chainId}`);
  }

  const topazPath = path.resolve(String(process.env.TOPAZ_MANIFEST || "deployments/bscTestnet/minimal-topaz.json"));
  const { manifest: topaz } = loadAuthoritativeTopazManifest(topazPath);
  const t = topaz.contracts;
  await Promise.all(Object.entries(t).map(([label, address]) => requireCode(String(address), `Topaz ${label}`)));

  const routerProbe = new ethers.Contract(t.Router, [
    "function defaultFactory() view returns (address)",
    "function factoryRegistry() view returns (address)",
    "function weth() view returns (address)",
  ], ethers.provider);
  const poolFactoryProbe = new ethers.Contract(t.PoolFactory, [
    "function implementation() view returns (address)",
    "function getFee(address,bool) view returns (uint256)",
  ], ethers.provider);
  assertRuntimeTopazIdentity({
    chainId,
    router: t.Router,
    poolFactory: await routerProbe.defaultFactory(),
    factoryRegistry: await routerProbe.factoryRegistry(),
    wbnb: await routerProbe.weth(),
    poolImplementation: await poolFactoryProbe.implementation(),
    volatileFeeBps: Number(await poolFactoryProbe.getFee(ethers.ZeroAddress, false)),
  }, topaz);

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const admin = envAddress("BNB_TESTNET_ADMIN", deployerAddress);
  if (!sameAddress(admin, deployerAddress)) throw new Error("real Topaz staged deployer must control BNB_TESTNET_ADMIN");
  const routeAuthority = resolveBnb6cRouteAuthority({ chainId, deployerAddress }).address;
  if (sameAddress(routeAuthority, deployerAddress) || sameAddress(routeAuthority, LIVE_97_ROUTE_AUTHORITY)) {
    throw new Error("real Topaz route authority must be isolated from deployer and live route authority");
  }

  const liveBefore = await snapshotLiveBnbTestnetFactory(ethers.provider);
  const deploymentStartBlock = await ethers.provider.getBlockNumber();

  const Adapter = await ethers.getContractFactory("TopazRouterAdapter");
  const adapter = await Adapter.deploy(t.Router);
  await adapter.waitForDeployment();
  const adapterDeployment = await deploymentEvidence(adapter, "TopazRouterAdapter");
  eq("adapter.topazRouter", await adapter.topazRouter(), t.Router);
  eq("adapter.poolFactory", await adapter.poolFactory(), t.PoolFactory);
  eq("adapter.WETH", await adapter.WETH(), t.WBNB);

  const testNativeUsdPrice = String(process.env.BNB_6C_TEST_NATIVE_USD_PRICE || DEFAULT_TEST_NATIVE_USD_PRICE).trim();
  const parsedTestPrice = ethers.parseUnits(testNativeUsdPrice, 8);
  if (parsedTestPrice <= 0n) throw new Error("BNB_6C_TEST_NATIVE_USD_PRICE must be positive");
  const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
  const priceFeed = await PriceFeed.deploy(8);
  await priceFeed.waitForDeployment();
  const priceFeedDeployment = await deploymentEvidence(priceFeed, "MockUsdPriceFeed");
  const latest = await ethers.provider.getBlock("latest");
  const timestamp = BigInt(latest!.timestamp);
  await (await priceFeed.setRoundData(1n, parsedTestPrice, timestamp, timestamp, 1n)).wait();

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const graduationOracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 30 * 24 * 60 * 60);
  await graduationOracle.waitForDeployment();
  const graduationOracleDeployment = await deploymentEvidence(graduationOracle, "GraduationOracle");

  const WeeklyVault = await ethers.getContractFactory("TreasuryVaultV2");
  const weeklyLeagueVault = await WeeklyVault.deploy(admin, ethers.ZeroAddress, admin);
  await weeklyLeagueVault.waitForDeployment();
  const weeklyLeagueVaultDeployment = await deploymentEvidence(weeklyLeagueVault, "WeeklyLeagueVault");
  const Charity = await ethers.getContractFactory("CharityTreasury");
  const charityTreasury = await Charity.deploy(admin);
  await charityTreasury.waitForDeployment();
  const charityTreasuryDeployment = await deploymentEvidence(charityTreasury, "CharityTreasury");
  const Monthly = await ethers.getContractFactory("MonthlyLeagueTreasury");
  const monthlyLeagueTreasury = await Monthly.deploy(admin, admin, await graduationOracle.getAddress(), await charityTreasury.getAddress(), 1_500_000n * 10n ** 18n);
  await monthlyLeagueTreasury.waitForDeployment();
  const monthlyLeagueTreasuryDeployment = await deploymentEvidence(monthlyLeagueTreasury, "MonthlyLeagueTreasury");
  const Recruiter = await ethers.getContractFactory("RecruiterRewardsVault");
  const recruiterRewardsVault = await Recruiter.deploy(admin);
  await recruiterRewardsVault.waitForDeployment();
  const recruiterRewardsVaultDeployment = await deploymentEvidence(recruiterRewardsVault, "RecruiterRewardsVault");
  const Protocol = await ethers.getContractFactory("ProtocolRevenueVault");
  const protocolRevenueVault = await Protocol.deploy(admin);
  await protocolRevenueVault.waitForDeployment();
  const protocolRevenueVaultDeployment = await deploymentEvidence(protocolRevenueVault, "ProtocolRevenueVault");
  const Treasury = await ethers.getContractFactory("TreasuryRouterV3");
  const treasuryRouter = await Treasury.deploy(admin, await weeklyLeagueVault.getAddress(), await monthlyLeagueTreasury.getAddress(), TREASURY_UPGRADE_DELAY);
  await treasuryRouter.waitForDeployment();
  const treasuryRouterDeployment = await deploymentEvidence(treasuryRouter, "TreasuryRouterV3");
  const Community = await ethers.getContractFactory("CommunityRewardsVault");
  const communityRewardsVault = await Community.deploy(admin, await treasuryRouter.getAddress());
  await communityRewardsVault.waitForDeployment();
  const communityRewardsVaultDeployment = await deploymentEvidence(communityRewardsVault, "CommunityRewardsVault");
  const CreatorRewards = await ethers.getContractFactory("CreatorRewardsVault");
  const creatorRewardsVault = await CreatorRewards.deploy(admin, await treasuryRouter.getAddress());
  await creatorRewardsVault.waitForDeployment();
  const creatorRewardsVaultDeployment = await deploymentEvidence(creatorRewardsVault, "CreatorRewardsVault");

  await (await treasuryRouter.setRecruiterRewardsVault(await recruiterRewardsVault.getAddress())).wait();
  await (await treasuryRouter.setCommunityRewardsVault(await communityRewardsVault.getAddress())).wait();
  await (await treasuryRouter.setProtocolRevenueVault(await protocolRevenueVault.getAddress())).wait();
  await (await treasuryRouter.setCreatorRewardsVault(await creatorRewardsVault.getAddress())).wait();

  const CreatorRegistry = await ethers.getContractFactory("CreatorRegistry");
  const creatorRegistry = await CreatorRegistry.deploy();
  await creatorRegistry.waitForDeployment();
  const creatorRegistryDeployment = await deploymentEvidence(creatorRegistry, "CreatorRegistry");
  const RiskRegistry = await ethers.getContractFactory("RiskRegistry");
  const riskRegistry = await RiskRegistry.deploy();
  await riskRegistry.waitForDeployment();
  const riskRegistryDeployment = await deploymentEvidence(riskRegistry, "RiskRegistry");
  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const campaignImplementation = await Campaign.deploy();
  await campaignImplementation.waitForDeployment();
  const campaignImplementationDeployment = await deploymentEvidence(campaignImplementation, "LaunchCampaign implementation");
  const LaunchFactory = await ethers.getContractFactory("LaunchFactory");
  const launchFactory = await LaunchFactory.deploy(await adapter.getAddress(), await treasuryRouter.getAddress(), await campaignImplementation.getAddress(), await graduationOracle.getAddress());
  await launchFactory.waitForDeployment();
  const launchFactoryDeployment = await deploymentEvidence(launchFactory, "LaunchFactory");
  const lockerAddress = await launchFactory.permanentLpLocker();
  const locker = await ethers.getContractAt("PermanentLpLocker", lockerAddress);

  const currentConfig = await launchFactory.config();
  await (await launchFactory.setConfig({
    totalSupply: currentConfig.totalSupply,
    curveBps: currentConfig.curveBps,
    liquidityTokenBps: currentConfig.liquidityTokenBps,
    basePrice: currentConfig.basePrice,
    priceSlope: currentConfig.priceSlope,
    graduationTarget: TEST_GRADUATION_TARGET_USD,
    liquidityBps: currentConfig.liquidityBps,
  })).wait();
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
    realTopazRouter: t.Router,
    realTopazFactory: t.PoolFactory,
    realTopazFactoryRegistry: t.FactoryRegistry,
    realWbnb: t.WBNB,
    realTopazPoolImplementation: t.PoolImplementation,
    topazRouterAdapter: await adapter.getAddress(),
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
  assertNewStackAvoidsLiveAddresses([
    contracts.topazRouterAdapter,
    contracts.mockNativeUsdPriceFeed,
    contracts.graduationOracle,
    contracts.weeklyLeagueVault,
    contracts.charityTreasury,
    contracts.monthlyLeagueTreasury,
    contracts.recruiterRewardsVault,
    contracts.protocolRevenueVault,
    contracts.treasuryRouterV3,
    contracts.communityRewardsVault,
    contracts.creatorRewardsVault,
    contracts.creatorRegistry,
    contracts.riskRegistry,
    contracts.launchCampaignImplementation,
    contracts.launchFactory,
    contracts.permanentLpLocker,
  ]);

  eq("factory generation", await launchFactory.FACTORY_GENERATION(), EXPECTED_FACTORY_GENERATION);
  eq("campaign generation", await launchFactory.CAMPAIGN_GENERATION(), EXPECTED_CAMPAIGN_GENERATION);
  eq("liquidityKind", await launchFactory.liquidityKind(), EXPECTED_LIQUIDITY_KIND);
  eq("locker required fee", await locker.REQUIRED_POOL_FEE_BPS(), REQUIRED_POOL_FEE_BPS);
  eq("locker topazFactory", await locker.topazFactory(), t.PoolFactory);
  if (await launchFactory.live()) throw new Error("staged real-Topaz factory unexpectedly live");
  if (!(await launchFactory.createPaused())) throw new Error("staged real-Topaz factory must remain createPaused");
  if (!(await launchFactory.securityDefaultsLocked())) throw new Error("security defaults not locked");
  if (!(await treasuryRouter.authorizedLpLocker(lockerAddress))) throw new Error("TreasuryRouterV3 does not authorize locker");
  if (sameAddress(await treasuryRouter.getAddress(), LIVE_97_TREASURY_V2) || sameAddress(await launchFactory.getAddress(), LIVE_97_FACTORY)) {
    throw new Error("real-Topaz staging reused live protocol identities");
  }

  const liveAfter = await snapshotLiveBnbTestnetFactory(ethers.provider);
  if (JSON.stringify(liveBefore) !== JSON.stringify(liveAfter)) throw new Error("live BNB factory changed during real-Topaz staging deploy");

  const deploymentProvenance = {
    TopazRouterAdapter: adapterDeployment,
    MockUsdPriceFeed: priceFeedDeployment,
    GraduationOracle: graduationOracleDeployment,
    WeeklyLeagueVault: weeklyLeagueVaultDeployment,
    CharityTreasury: charityTreasuryDeployment,
    MonthlyLeagueTreasury: monthlyLeagueTreasuryDeployment,
    RecruiterRewardsVault: recruiterRewardsVaultDeployment,
    ProtocolRevenueVault: protocolRevenueVaultDeployment,
    TreasuryRouterV3: treasuryRouterDeployment,
    CommunityRewardsVault: communityRewardsVaultDeployment,
    CreatorRewardsVault: creatorRewardsVaultDeployment,
    CreatorRegistry: creatorRegistryDeployment,
    RiskRegistry: riskRegistryDeployment,
    LaunchCampaignImplementation: campaignImplementationDeployment,
    LaunchFactory: launchFactoryDeployment,
    PermanentLpLocker: {
      address: lockerAddress,
      txHash: null,
      receiptBlock: launchFactoryDeployment.receiptBlock,
      provenance: "factory-created/internal",
      createdBy: contracts.launchFactory,
    },
  };

  const stage = {
    schemaVersion: 2,
    kind: "bnb-real-topaz-testnet-stage",
    targetChainId: 97,
    chainId,
    network: network.name,
    environment: "staging",
    deployedAt: new Date().toISOString(),
    deploymentStartBlock,
    deploymentBlock: adapterDeployment.receiptBlock,
    sourceBaseSha,
    topazDeploymentAuthority: TOPAZ_DEPLOYMENT_AUTHORITY,
    topazManifest: path.relative(process.cwd(), topazPath).replace(/\\/g, "/"),
    factoryGeneration: 4,
    campaignGeneration: 3,
    liquidityKind: 1,
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
    deploymentProvenance,
    stagingOnly: {
      controlledTopazDex: false,
      realTopazCompatibility: true,
      wrappedWithTopazRouterAdapter: true,
      mockNativeUsdPriceFeed: true,
      productionCompatible: false,
    },
    liveBnbUntouched: { factory: LIVE_97_FACTORY, treasuryRouterV2: LIVE_97_TREASURY_V2, snapshot: liveAfter },
  };

  const outFile = path.resolve(String(process.env.BNB_REAL_TOPAZ_STAGE_DEPLOYMENT_FILE || "reports/bnb-real-topaz-testnet-stage.json"));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(stage, null, 2)}\n`);
  console.log(`[bnb-real-topaz-stage] manifest=${outFile}`);
  console.log(`[bnb-real-topaz-stage] launchFactory=${contracts.launchFactory}`);
  console.log("[bnb-real-topaz-stage] live=false createPaused=true controlledTopazDex=false realTopazCompatibility=true");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
