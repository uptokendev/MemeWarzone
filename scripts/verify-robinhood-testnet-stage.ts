import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
const LOCAL_CHAIN_ID = 31337;
const EXPECTED_FACTORY_GENERATION = 4n;
const EXPECTED_CAMPAIGN_GENERATION = 3n;
const EXPECTED_LIQUIDITY_KIND = 2n;
const EXPECTED_V3_FEE_TIER = 3000n;
const TEST_GRADUATION_TARGET_USD = ethers.parseEther("6");

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function sameAddress(a: unknown, b: unknown): boolean {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function requireAddress(value: unknown, label: string): string {
  const raw = String(value || "").trim();
  if (!ethers.isAddress(raw) || raw === ethers.ZeroAddress) throw new Error(`${label} is missing or invalid: ${raw}`);
  return ethers.getAddress(raw);
}

async function requireCode(address: string, label: string): Promise<void> {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") throw new Error(`${label} has no bytecode at ${address}`);
}

function assertEq(label: string, actual: unknown, expected: unknown): void {
  if (String(actual) !== String(expected)) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function assertAddress(label: string, actual: unknown, expected: unknown): void {
  if (!sameAddress(actual, expected)) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const allowLocal = truthy(process.env.ALLOW_LOCAL_RH_PROTOCOL_STAGE);
  if (chainId !== ROBINHOOD_TESTNET_CHAIN_ID && !(allowLocal && chainId === LOCAL_CHAIN_ID)) {
    throw new Error(`Robinhood stage verifier refuses chain ${chainId}`);
  }

  const explicit = String(process.env.ROBINHOOD_STAGE_DEPLOYMENT_FILE || "").trim();
  const manifestPath = explicit
    ? path.resolve(explicit)
    : chainId === ROBINHOOD_TESTNET_CHAIN_ID
      ? path.resolve("deployments/robinhood/testnet.staged.json")
      : path.resolve(".tmp/robinhood-testnet-stage.local.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Staged Robinhood manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assertEq("manifest targetChainId", manifest.targetChainId, ROBINHOOD_TESTNET_CHAIN_ID);
  assertEq("manifest connected chainId", manifest.chainId, chainId);
  assertEq("manifest factoryGeneration", manifest.factoryGeneration, 4);
  assertEq("manifest campaignGeneration", manifest.campaignGeneration, 3);
  assertEq("manifest liquidityKind", manifest.liquidityKind, 2);
  if (manifest.creationEnabled !== false || manifest.supportEnabled !== false || manifest.factoryLive !== false) {
    throw new Error("Staged manifest must keep support/creation/factoryLive disabled");
  }
  if (manifest.stagingOnly?.controlledV3Dex !== true || manifest.stagingOnly?.mockNativeUsdPriceFeed !== true) {
    throw new Error("Staged manifest must explicitly mark controlled V3 and mock price-feed dependencies");
  }
  if (manifest.stagingOnly?.productionCompatible !== false || manifest.stagingOnly?.correctedFeeModel !== true) {
    throw new Error("Staged manifest must be marked as the corrected non-production fee model");
  }

  const c = manifest.contracts || {};
  const addresses = {
    mockWeth9: requireAddress(c.mockWeth9, "mockWeth9"),
    mockV3Factory: requireAddress(c.mockV3Factory, "mockV3Factory"),
    mockNonfungiblePositionManager: requireAddress(c.mockNonfungiblePositionManager, "mockNonfungiblePositionManager"),
    mockSwapRouter02: requireAddress(c.mockSwapRouter02, "mockSwapRouter02"),
    graduationAdapter: requireAddress(c.graduationAdapter, "graduationAdapter"),
    mockNativeUsdPriceFeed: requireAddress(c.mockNativeUsdPriceFeed, "mockNativeUsdPriceFeed"),
    graduationOracle: requireAddress(c.graduationOracle, "graduationOracle"),
    weeklyLeagueVault: requireAddress(c.weeklyLeagueVault, "weeklyLeagueVault"),
    charityTreasury: requireAddress(c.charityTreasury, "charityTreasury"),
    monthlyLeagueTreasury: requireAddress(c.monthlyLeagueTreasury, "monthlyLeagueTreasury"),
    recruiterRewardsVault: requireAddress(c.recruiterRewardsVault, "recruiterRewardsVault"),
    protocolRevenueVault: requireAddress(c.protocolRevenueVault, "protocolRevenueVault"),
    treasuryRouterV3: requireAddress(c.treasuryRouterV3, "treasuryRouterV3"),
    communityRewardsVault: requireAddress(c.communityRewardsVault, "communityRewardsVault"),
    creatorRewardsVault: requireAddress(c.creatorRewardsVault, "creatorRewardsVault"),
    creatorRegistry: requireAddress(c.creatorRegistry, "creatorRegistry"),
    riskRegistry: requireAddress(c.riskRegistry, "riskRegistry"),
    launchCampaignImplementation: requireAddress(c.launchCampaignImplementation, "launchCampaignImplementation"),
    launchFactory: requireAddress(c.launchFactory, "launchFactory"),
    permanentV3PositionLocker: requireAddress(c.permanentV3PositionLocker, "permanentV3PositionLocker"),
  };

  await Promise.all(Object.entries(addresses).map(([label, address]) => requireCode(address, label)));

  const adapter = await ethers.getContractAt("RobinhoodUniswapV3GraduationAdapter", addresses.graduationAdapter);
  const v3Factory = await ethers.getContractAt("MockUniswapV3Factory", addresses.mockV3Factory);
  const positionManager = await ethers.getContractAt("MockUniswapV3PositionManager", addresses.mockNonfungiblePositionManager);
  const swapRouter = await ethers.getContractAt("MockUniswapV3SwapRouter", addresses.mockSwapRouter02);
  const oracle = await ethers.getContractAt("GraduationOracle", addresses.graduationOracle);
  const factory = await ethers.getContractAt("LaunchFactory", addresses.launchFactory);
  const locker = await ethers.getContractAt("PermanentV3PositionLocker", addresses.permanentV3PositionLocker);
  const treasury = await ethers.getContractAt("TreasuryRouterV3", addresses.treasuryRouterV3);
  const creatorVault = await ethers.getContractAt("CreatorRewardsVault", addresses.creatorRewardsVault);
  const creatorRegistry = await ethers.getContractAt("CreatorRegistry", addresses.creatorRegistry);
  const riskRegistry = await ethers.getContractAt("RiskRegistry", addresses.riskRegistry);
  const community = await ethers.getContractAt("CommunityRewardsVault", addresses.communityRewardsVault);
  const weekly = await ethers.getContractAt("TreasuryVaultV2", addresses.weeklyLeagueVault);
  const monthly = await ethers.getContractAt("MonthlyLeagueTreasury", addresses.monthlyLeagueTreasury);
  const recruiter = await ethers.getContractAt("RecruiterRewardsVault", addresses.recruiterRewardsVault);
  const protocol = await ethers.getContractAt("ProtocolRevenueVault", addresses.protocolRevenueVault);
  const charity = await ethers.getContractAt("CharityTreasury", addresses.charityTreasury);

  assertEq("adapter liquidityKind", await adapter.liquidityKind(), EXPECTED_LIQUIDITY_KIND);
  assertEq("adapter feeTier", await adapter.feeTier(), EXPECTED_V3_FEE_TIER);
  assertAddress("adapter poolFactory compatibility boundary", await adapter.poolFactory(), addresses.graduationAdapter);
  assertAddress("adapter V3 factory", await adapter.v3Factory(), addresses.mockV3Factory);
  assertAddress("adapter position manager", await adapter.positionManager(), addresses.mockNonfungiblePositionManager);
  assertAddress("adapter WETH", await adapter.WETH(), addresses.mockWeth9);

  assertAddress("V3 factory position manager", await v3Factory.positionManager(), addresses.mockNonfungiblePositionManager);
  assertAddress("V3 factory swap router", await v3Factory.swapRouter(), addresses.mockSwapRouter02);
  assertEq("V3 fee tick spacing", await v3Factory.feeAmountTickSpacing(EXPECTED_V3_FEE_TIER), 60n);
  assertAddress("position manager factory", await positionManager.factory(), addresses.mockV3Factory);
  assertAddress("position manager WETH", await positionManager.WETH9(), addresses.mockWeth9);
  assertAddress("swap router factory", await swapRouter.factory(), addresses.mockV3Factory);
  assertAddress("swap router WETH", await swapRouter.WETH9(), addresses.mockWeth9);

  assertEq("factory generation", await factory.FACTORY_GENERATION(), EXPECTED_FACTORY_GENERATION);
  assertEq("campaign generation", await factory.CAMPAIGN_GENERATION(), EXPECTED_CAMPAIGN_GENERATION);
  assertEq("factory liquidityKind", await factory.liquidityKind(), EXPECTED_LIQUIDITY_KIND);
  assertAddress("factory router", await factory.router(), addresses.graduationAdapter);
  assertAddress("factory treasury fee recipient", await factory.feeRecipient(), addresses.treasuryRouterV3);
  assertAddress("factory league receiver", await factory.leagueReceiver(), addresses.treasuryRouterV3);
  assertAddress("factory graduation oracle", await factory.graduationOracle(), addresses.graduationOracle);
  assertAddress("factory CreatorRegistry", await factory.creatorRegistry(), addresses.creatorRegistry);
  assertAddress("factory RiskRegistry", await factory.riskRegistry(), addresses.riskRegistry);
  assertAddress("factory campaign implementation", await factory.campaignImplementation(), addresses.launchCampaignImplementation);
  assertAddress("factory V3 locker", await factory.permanentLpLocker(), addresses.permanentV3PositionLocker);
  assertAddress("factory route authority", await factory.routeAuthority(), manifest.routeAuthority);
  assertEq("factory live", await factory.live(), false);
  assertEq("factory security defaults locked", await factory.securityDefaultsLocked(), true);
  assertEq("factory route auth required", await factory.requireRouteAuthorization(), true);
  assertEq("factory trade auth required", await factory.requireAuthorizedTrading(), true);
  assertEq("factory trade route profile", await factory.tradeRouteProfile(), 1n);
  assertEq("factory finalize route profile", await factory.finalizeRouteProfile(), 1n);
  assertEq("factory protocol fee", await factory.protocolFeeBps(), 200n);
  assertEq("factory graduation target", (await factory.config()).graduationTarget, TEST_GRADUATION_TARGET_USD);
  assertEq("factory test tier on Robinhood", await factory.isGraduationTargetAllowedForChain(46630, TEST_GRADUATION_TARGET_USD), true);
  assertEq("factory test tier on Robinhood mainnet", await factory.isGraduationTargetAllowedForChain(4663, TEST_GRADUATION_TARGET_USD), false);

  assertAddress("locker integration source", await locker.integrationSource(), addresses.graduationAdapter);
  assertAddress("locker position manager", await locker.positionManager(), addresses.mockNonfungiblePositionManager);
  assertAddress("locker V3 factory", await locker.v3Factory(), addresses.mockV3Factory);
  assertAddress("locker wrapped native", await locker.wrappedNative(), addresses.mockWeth9);
  assertAddress("locker treasury router", await locker.treasuryRouter(), addresses.treasuryRouterV3);
  assertEq("locker creator fee bps", await locker.CREATOR_FEE_BPS(), 8000n);
  assertEq("locker protocol fee bps", await locker.PROTOCOL_FEE_BPS(), 2000n);

  assertAddress("treasury admin", await treasury.admin(), manifest.admin);
  assertAddress("treasury weekly vault", await treasury.weeklyLeagueVault(), addresses.weeklyLeagueVault);
  assertAddress("treasury monthly vault", await treasury.monthlyLeagueTreasury(), addresses.monthlyLeagueTreasury);
  assertAddress("treasury recruiter vault", await treasury.recruiterRewardsVault(), addresses.recruiterRewardsVault);
  assertAddress("treasury community vault", await treasury.communityRewardsVault(), addresses.communityRewardsVault);
  assertAddress("treasury protocol vault", await treasury.protocolRevenueVault(), addresses.protocolRevenueVault);
  assertAddress("treasury creator vault", await treasury.creatorRewardsVault(), addresses.creatorRewardsVault);
  assertAddress("treasury primary LP locker", await treasury.permanentLpLocker(), addresses.permanentV3PositionLocker);
  assertEq("treasury locker authorized", await treasury.authorizedLpLocker(addresses.permanentV3PositionLocker), true);
  assertEq("treasury forwarding paused", await treasury.forwardingPaused(), false);

  assertAddress("creator vault admin", await creatorVault.admin(), manifest.admin);
  assertAddress("creator vault router", await creatorVault.router(), addresses.treasuryRouterV3);
  assertAddress("community admin", await community.admin(), manifest.admin);
  assertAddress("community router", await community.router(), addresses.treasuryRouterV3);
  assertAddress("weekly multisig", await weekly.multisig(), manifest.admin);
  assertEq("weekly payouts paused", await weekly.payoutsPaused(), true);
  assertEq("weekly claims paused", await weekly.claimsPaused(), true);
  assertAddress("monthly multisig", await monthly.multisig(), manifest.admin);
  assertAddress("monthly root poster", await monthly.rootPoster(), manifest.admin);
  assertAddress("monthly oracle", await monthly.oracle(), addresses.graduationOracle);
  assertAddress("monthly charity treasury", await monthly.charityTreasury(), addresses.charityTreasury);
  assertAddress("charity multisig", await charity.multisig(), manifest.admin);
  assertAddress("recruiter admin", await recruiter.admin(), manifest.admin);
  assertEq("recruiter payouts paused", await recruiter.payoutsPaused(), true);
  assertAddress("protocol admin", await protocol.admin(), manifest.admin);
  assertAddress("protocol operator remains unset", await protocol.operator(), ethers.ZeroAddress);

  assertAddress("CreatorRegistry owner", await creatorRegistry.owner(), manifest.admin);
  assertEq("CreatorRegistry launch recorder", await creatorRegistry.launchRecorder(addresses.launchFactory), true);
  assertAddress("RiskRegistry owner", await riskRegistry.owner(), manifest.admin);

  const nativeUsdPrice = await oracle.nativeUsdPrice();
  if (nativeUsdPrice <= 0n) throw new Error("GraduationOracle returned a zero native/USD price");
  const nativeForSixUsd = await oracle.nativeTargetForUsd(TEST_GRADUATION_TARGET_USD);
  if (nativeForSixUsd <= 0n) throw new Error("GraduationOracle returned a zero native target for the $6 tier");

  const standardTrade = await treasury.previewTrade(10_000n, 0);
  const standardTotal = standardTrade.league + standardTrade.creator + standardTrade.recruiter + standardTrade.airdrop + standardTrade.squad + standardTrade.protocol;
  assertEq("TreasuryRouterV3 standard trade conserves value", standardTotal, 10_000n);
  assertEq("TreasuryRouterV3 standard creator", standardTrade.creator, 500n);
  assertEq("TreasuryRouterV3 standard recruiter", standardTrade.recruiter, 1_250n);

  const ogTrade = await treasury.previewTrade(10_000n, 2);
  const ogTotal = ogTrade.league + ogTrade.creator + ogTrade.recruiter + ogTrade.airdrop + ogTrade.squad + ogTrade.protocol;
  assertEq("TreasuryRouterV3 OG trade conserves value", ogTotal, 10_000n);
  assertEq("TreasuryRouterV3 OG creator", ogTrade.creator, 500n);
  assertEq("TreasuryRouterV3 OG recruiter", ogTrade.recruiter, 1_500n);
  assertEq("TreasuryRouterV3 OG protocol", ogTrade.protocol, 4_000n);

  const unlinkedTrade = await treasury.previewTrade(10_000n, 1);
  const unlinkedTotal = unlinkedTrade.league + unlinkedTrade.creator + unlinkedTrade.recruiter + unlinkedTrade.airdrop + unlinkedTrade.squad + unlinkedTrade.protocol;
  assertEq("TreasuryRouterV3 unlinked trade conserves value", unlinkedTotal, 10_000n);
  assertEq("TreasuryRouterV3 unlinked creator", unlinkedTrade.creator, 500n);
  assertEq("TreasuryRouterV3 unlinked airdrop", unlinkedTrade.airdrop, 1_500n);

  const finalizePreview = await treasury.previewFinalize(10_000n, 1);
  const finalizeTotal = finalizePreview.league + finalizePreview.creator + finalizePreview.recruiter + finalizePreview.airdrop + finalizePreview.squad + finalizePreview.protocol;
  assertEq("TreasuryRouterV3 finalize conserves value", finalizeTotal, 10_000n);
  assertEq("TreasuryRouterV3 finalize creator", finalizePreview.creator, 0n);

  console.log("[robinhood-stage-verify] PASS", {
    manifest: manifestPath,
    chainId,
    factory: addresses.launchFactory,
    factoryGeneration: Number(await factory.FACTORY_GENERATION()),
    campaignGeneration: Number(await factory.CAMPAIGN_GENERATION()),
    liquidityKind: Number(await factory.liquidityKind()),
    permanentV3PositionLocker: addresses.permanentV3PositionLocker,
    nativeTargetForSixUsd: nativeForSixUsd.toString(),
    creationEnabled: false,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
