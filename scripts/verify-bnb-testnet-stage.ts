import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";
import { LIVE_97_FACTORY, LIVE_97_ROUTE_AUTHORITY, LIVE_97_TREASURY_V2 } from "./lib/bnbLiveFactorySnapshot";

const BNB_TESTNET_CHAIN_ID = 97;
const LOCAL_CHAIN_ID = 31337;
const EXPECTED_FACTORY_GENERATION = 4n;
const EXPECTED_CAMPAIGN_GENERATION = 3n;
const EXPECTED_LIQUIDITY_KIND = 1n;
const REQUIRED_POOL_FEE_BPS = 30n;
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
  const allowLocal = truthy(process.env.ALLOW_LOCAL_BNB_PROTOCOL_STAGE);
  if (chainId !== BNB_TESTNET_CHAIN_ID && !(allowLocal && chainId === LOCAL_CHAIN_ID)) {
    throw new Error(`BNB 6C stage verifier refuses chain ${chainId}`);
  }
  if (chainId === BNB_TESTNET_CHAIN_ID) {
    throw new Error("6C first cut is local rehearsal only. Refusing chain-97 verify until the rehearsal SHA is audited.");
  }

  const explicit = String(process.env.BNB_6C_STAGE_DEPLOYMENT_FILE || "").trim();
  const manifestPath = explicit
    ? path.resolve(explicit)
    : chainId === BNB_TESTNET_CHAIN_ID
      ? path.resolve("deployments/bnb/testnet.staged.json")
      : path.resolve(".tmp/bnb-testnet-stage.local.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Staged BNB 6C manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assertEq("manifest targetChainId", manifest.targetChainId, BNB_TESTNET_CHAIN_ID);
  assertEq("manifest factoryGeneration", manifest.factoryGeneration, 4);
  assertEq("manifest campaignGeneration", manifest.campaignGeneration, 3);
  assertEq("manifest liquidityKind", manifest.liquidityKind, 1);
  assertEq("manifest requiredPoolFeeBps", manifest.requiredPoolFeeBps, 30);
  if (manifest.creationEnabled !== false || manifest.supportEnabled !== false || manifest.factoryLive !== false) {
    throw new Error("Staged manifest must keep support/creation/factoryLive disabled");
  }
  if (manifest.stagingOnly?.controlledTopazDex !== true || manifest.stagingOnly?.wrappedWithTopazRouterAdapter !== false) {
    throw new Error("Staged manifest must mark an explicit controlled Topaz mock, not TopazRouterAdapter");
  }
  if (manifest.stagingOnly?.productionCompatible !== false || manifest.stagingOnly?.realTopazCompatibility !== false) {
    throw new Error("Staged manifest must not claim real Topaz or production compatibility");
  }
  if (manifest.stagingOnly?.uniswapV3Rejected !== true) throw new Error("Staged manifest must reject BNB Uniswap V3");
  if (!sameAddress(manifest.liveBnbUntouched?.factory, LIVE_97_FACTORY)) {
    throw new Error("Staged manifest must pin live 3/2 factory 0x77Af… as untouched");
  }

  const c = manifest.contracts || {};
  const addresses = {
    mockWbnb: requireAddress(c.mockWbnb, "mockWbnb"),
    mockTopazFactory: requireAddress(c.mockTopazFactory, "mockTopazFactory"),
    mockTopazRouter: requireAddress(c.mockTopazRouter, "mockTopazRouter"),
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
    permanentLpLocker: requireAddress(c.permanentLpLocker, "permanentLpLocker"),
  };
  await Promise.all(Object.entries(addresses).map(([label, address]) => requireCode(address, label)));
  if (sameAddress(addresses.launchFactory, LIVE_97_FACTORY)) throw new Error("6C factory is live 0x77Af…");
  if (sameAddress(addresses.treasuryRouterV3, LIVE_97_TREASURY_V2)) throw new Error("6C treasury is live V2");
  if (sameAddress(manifest.routeAuthority, LIVE_97_ROUTE_AUTHORITY)) throw new Error("6C route authority is live 0xb989…");
  if (sameAddress(manifest.routeAuthority, manifest.admin)) throw new Error("6C route authority must differ from admin");

  const factory = await ethers.getContractAt("LaunchFactory", addresses.launchFactory);
  const locker = await ethers.getContractAt("PermanentLpLocker", addresses.permanentLpLocker);
  const treasury = await ethers.getContractAt("TreasuryRouterV3", addresses.treasuryRouterV3);
  const topazFactory = await ethers.getContractAt("MockTopazFactory", addresses.mockTopazFactory);
  const router = await ethers.getContractAt("MockTopazRouter", addresses.mockTopazRouter);
  const creatorVault = await ethers.getContractAt("CreatorRewardsVault", addresses.creatorRewardsVault);

  assertEq("factory generation", await factory.FACTORY_GENERATION(), EXPECTED_FACTORY_GENERATION);
  assertEq("campaign generation", await factory.CAMPAIGN_GENERATION(), EXPECTED_CAMPAIGN_GENERATION);
  assertEq("factory liquidityKind", await factory.liquidityKind(), EXPECTED_LIQUIDITY_KIND);
  assertAddress("factory router", await factory.router(), addresses.mockTopazRouter);
  assertAddress("factory treasury", await factory.feeRecipient(), addresses.treasuryRouterV3);
  assertAddress("factory locker", await factory.permanentLpLocker(), addresses.permanentLpLocker);
  assertAddress("factory route authority", await factory.routeAuthority(), manifest.routeAuthority);
  assertEq("factory live", await factory.live(), false);
  assertEq("factory createPaused", await factory.createPaused(), true);
  assertEq("factory security locked", await factory.securityDefaultsLocked(), true);
  assertEq("factory protocol fee", await factory.protocolFeeBps(), 200n);
  assertEq("factory graduation target", (await factory.config()).graduationTarget, TEST_GRADUATION_TARGET_USD);
  assertEq("locker required fee", await locker.REQUIRED_POOL_FEE_BPS(), REQUIRED_POOL_FEE_BPS);
  assertEq("topaz fee", await topazFactory.feeBps(), REQUIRED_POOL_FEE_BPS);
  assertAddress("router pool factory", await router.poolFactory(), addresses.mockTopazFactory);
  assertAddress("router WBNB", await router.WETH(), addresses.mockWbnb);
  assertEq("treasury creator vault", await treasury.creatorRewardsVault(), addresses.creatorRewardsVault);
  assertEq("creator vault router", await creatorVault.router(), addresses.treasuryRouterV3);
  const withdrawFns = locker.interface.fragments.filter((fragment) => String((fragment as { name?: string }).name || "") === "withdraw");
  if (withdrawFns.length) throw new Error("PermanentLpLocker must not expose withdraw");

  console.log("[bnb-6c-verify] independent staged verification passed", {
    network: network.name,
    chainId,
    factory: addresses.launchFactory,
    live: false,
    createPaused: true,
    liquidityKind: 1,
    requiredPoolFeeBps: 30,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
