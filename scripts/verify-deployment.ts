import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

function assertEq(label: string, actual: string, expected: string) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
  console.log(`[verify] ${label}: ok`);
}

function assertBigIntEq(label: string, actual: bigint, expected: bigint) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
  console.log(`[verify] ${label}: ok`);
}

function assertTrue(label: string, value: boolean) {
  if (!value) throw new Error(`${label}: expected true`);
  console.log(`[verify] ${label}: ok`);
}

function assertAddress(label: string, value: string) {
  if (!value || value === ethers.ZeroAddress) throw new Error(`${label}: expected non-zero address`);
}

export function hardhatEphemeralHint() {
  return network.name === "hardhat"
    ? " Hardhat's default network is ephemeral between commands; use npm run deploy:verify, or verify against a persistent localhost/testnet network."
    : "";
}

export async function assertCode(label: string, address: string) {
  if (!address || address === ethers.ZeroAddress) {
    throw new Error(
      `${label}: missing address in deployment file. Redeploy with the current scripts/deploy.ts or update DEPLOYMENT_FILE to a current deployment JSON.`
    );
  }
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${label}: ${address} has no code on ${network.name}.${hardhatEphemeralHint()}`);
  console.log(`[verify] ${label} code: ok`);
}

async function readAddressGetter(label: string, address: string, candidates: string[]) {
  const errors: string[] = [];
  for (const candidate of candidates) {
    const contract = new ethers.Contract(address, [`function ${candidate}() view returns (address)`], ethers.provider);
    try {
      const value = await contract[candidate]();
      assertAddress(`${label}.${candidate}`, value);
      console.log(`[verify] ${label}.${candidate}: ok`);
      return { name: candidate, value };
    } catch (error: any) {
      errors.push(`${candidate}: ${error?.message ?? String(error)}`);
    }
  }
  throw new Error(`${label}: ${address} does not expose any of ${candidates.join(", ")}. ${errors.join(" | ")}`);
}

export async function assertTopazRouter(label: string, address: string) {
  await assertCode(label, address);

  try {
    const poolFactory = await readAddressGetter(label, address, ["defaultFactory", "poolFactory"]);
    const wrappedNative = await readAddressGetter(label, address, ["weth", "WETH"]);

    await assertCode(`${label}.${poolFactory.name}`, poolFactory.value);
    await assertCode(`${label}.${wrappedNative.name}`, wrappedNative.value);

    const factory = new ethers.Contract(
      poolFactory.value,
      ["function getFee(address pool, bool stable) view returns (uint256)"],
      ethers.provider
    );
    const volatileFeeBps = await factory.getFee(ethers.ZeroAddress, false);
    assertBigIntEq(`${label}.${poolFactory.name}.volatileFeeBps`, volatileFeeBps, 30n);
    console.log(`[verify] ${label} Minimal Topaz interface: ok`);
  } catch (error: any) {
    throw new Error(`${label}: ${address} does not expose the Topaz router interface. ${error?.message ?? String(error)}`);
  }
}

export function pickAddress(deployment: any, canonicalName: string, fallbacks: string[] = []) {
  const contracts = deployment.contracts ?? {};
  for (const key of [canonicalName, ...fallbacks]) {
    const fromContracts = contracts[key];
    if (typeof fromContracts === "string" && fromContracts) return fromContracts;
    const topLevel = deployment[key];
    if (typeof topLevel === "string" && topLevel) return topLevel;
  }
  return "";
}

export function resolveContracts(deployment: any) {
  return {
    TreasuryVaultV2: pickAddress(deployment, "TreasuryVaultV2", ["LeagueTreasury", "leagueTreasury", "treasuryVault", "vault"]),
    TreasuryRouter: pickAddress(deployment, "TreasuryRouter", ["TreasuryRouterV2", "treasuryRouterV2", "treasuryRouter", "leagueRouter", "routerAddress"]),
    TreasuryRouterV2: pickAddress(deployment, "TreasuryRouterV2", ["treasuryRouterV2"]),
    WeeklyLeagueVault: pickAddress(deployment, "WeeklyLeagueVault", ["weeklyLeagueVault", "activeLeagueVault"]),
    MonthlyLeagueTreasury: pickAddress(deployment, "MonthlyLeagueTreasury", ["monthlyLeagueTreasury"]),
    CharityTreasury: pickAddress(deployment, "CharityTreasury", ["charityTreasury"]),
    RecruiterRewardsVault: pickAddress(deployment, "RecruiterRewardsVault", ["recruiterRewardsVault", "recruiterVault"]),
    CommunityRewardsVault: pickAddress(deployment, "CommunityRewardsVault", ["communityRewardsVault", "communityVault"]),
    ProtocolRevenueVault: pickAddress(deployment, "ProtocolRevenueVault", ["protocolRevenueVault", "protocolVault"]),
    CreatorRegistry: pickAddress(deployment, "CreatorRegistry", ["creatorRegistry"]),
    RiskRegistry: pickAddress(deployment, "RiskRegistry", ["riskRegistry"]),
    GraduationOracle: pickAddress(deployment, "GraduationOracle", ["graduationOracle"]),
    LaunchCampaignImplementation: pickAddress(deployment, "LaunchCampaignImplementation", ["campaignImplementation"]),
    LaunchFactory: pickAddress(deployment, "LaunchFactory", ["factory", "factoryAddress"]),
    PermanentLpLocker: pickAddress(deployment, "PermanentLpLocker", ["permanentLpLocker"]),
    UPVoteTreasury: pickAddress(deployment, "UPVoteTreasury", ["voteTreasury", "voteTreasuryAddress"]),
  };
}

function isTreasuryRouterV2Deployment(deployment: any, contracts: ReturnType<typeof resolveContracts>) {
  return (
    deployment.treasuryRouterVersion === "v2" ||
    Boolean(contracts.TreasuryRouterV2) ||
    Boolean(deployment.routing?.monthlyLeagueTreasury) ||
    Boolean(deployment.monthlyLeagueTreasury)
  );
}

export function loadDeployment() {
  const file = process.env.DEPLOYMENT_FILE
    ? path.resolve(process.env.DEPLOYMENT_FILE)
    : path.join(__dirname, "..", "deployments", `${network.name}.json`);

  if (!fs.existsSync(file)) {
    throw new Error(`Deployment file not found: ${file}. Run scripts/deploy.ts first or set DEPLOYMENT_FILE.`);
  }

  const deployment = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`[verify] Loaded deployment: ${file}`);
  return deployment;
}

async function verifyMonthlyLeagueTreasury(deployment: any, contracts: ReturnType<typeof resolveContracts>) {
  const monthlyLeagueTreasury = contracts.MonthlyLeagueTreasury || deployment.routing?.monthlyLeagueTreasury || deployment.monthlyLeagueTreasury;
  const charityTreasury = contracts.CharityTreasury || deployment.routing?.charityTreasury || deployment.charityTreasury;

  await assertCode("MonthlyLeagueTreasury", monthlyLeagueTreasury);
  await assertCode("CharityTreasury", charityTreasury);

  const monthly = new ethers.Contract(
    monthlyLeagueTreasury,
    [
      "function multisig() view returns (address)",
      "function rootPoster() view returns (address)",
      "function oracle() view returns (address)",
      "function charityTreasury() view returns (address)",
      "function monthlyCapUsd() view returns (uint256)",
    ],
    ethers.provider
  );

  assertEq("MonthlyLeagueTreasury.multisig", await monthly.multisig(), deployment.treasurySafe);
  if (deployment.leagueRootPoster && deployment.leagueRootPoster !== ethers.ZeroAddress) {
    assertEq("MonthlyLeagueTreasury.rootPoster", await monthly.rootPoster(), deployment.leagueRootPoster);
  }
  assertEq("MonthlyLeagueTreasury.oracle", await monthly.oracle(), contracts.GraduationOracle);
  assertEq("MonthlyLeagueTreasury.charityTreasury", await monthly.charityTreasury(), charityTreasury);

  const configuredCap = BigInt(deployment.monthlyLeagueCapUsd ?? deployment.routing?.monthlyLeagueCapUsd ?? 0);
  const expectedCap = configuredCap === 0n ? ethers.parseUnits("1500000", 18) : configuredCap;
  assertBigIntEq("MonthlyLeagueTreasury.monthlyCapUsd", BigInt(await monthly.monthlyCapUsd()), expectedCap);

  const charity = new ethers.Contract(charityTreasury, ["function multisig() view returns (address)"], ethers.provider);
  assertEq("CharityTreasury.multisig", await charity.multisig(), deployment.treasurySafe);
}

async function verifyTreasuryRouterV2(deployment: any, contracts: ReturnType<typeof resolveContracts>) {
  const routerAddress = contracts.TreasuryRouterV2 || contracts.TreasuryRouter;
  const weeklyLeagueVault = contracts.WeeklyLeagueVault || deployment.routing?.weeklyLeagueVault || contracts.TreasuryVaultV2;
  const monthlyLeagueTreasury = contracts.MonthlyLeagueTreasury || deployment.routing?.monthlyLeagueTreasury || deployment.monthlyLeagueTreasury;
  const expectedWeeklyBps = BigInt(deployment.weeklyLeagueBps ?? deployment.routing?.weeklyLeagueBps ?? 3000);
  const expectedMonthlyBps = BigInt(deployment.monthlyLeagueBps ?? deployment.routing?.monthlyLeagueBps ?? 7000);

  await assertCode("TreasuryRouterV2", routerAddress);
  await assertCode("WeeklyLeagueVault", weeklyLeagueVault);
  await assertCode("MonthlyLeagueTreasury", monthlyLeagueTreasury);

  const router = new ethers.Contract(
    routerAddress,
    [
      "function weeklyLeagueVault() view returns (address)",
      "function monthlyLeagueTreasury() view returns (address)",
      "function weeklyLeagueBps() view returns (uint16)",
      "function monthlyLeagueBps() view returns (uint16)",
      "function recruiterRewardsVault() view returns (address)",
      "function communityRewardsVault() view returns (address)",
      "function protocolRevenueVault() view returns (address)",
      "function permanentLpLocker() view returns (address)",
      "function authorizedLpLocker(address locker) view returns (bool)",
    ],
    ethers.provider
  );

  assertEq("TreasuryRouterV2.weeklyLeagueVault", await router.weeklyLeagueVault(), weeklyLeagueVault);
  assertEq("TreasuryRouterV2.monthlyLeagueTreasury", await router.monthlyLeagueTreasury(), monthlyLeagueTreasury);
  assertBigIntEq("TreasuryRouterV2.weeklyLeagueBps", BigInt(await router.weeklyLeagueBps()), expectedWeeklyBps);
  assertBigIntEq("TreasuryRouterV2.monthlyLeagueBps", BigInt(await router.monthlyLeagueBps()), expectedMonthlyBps);
  assertEq("TreasuryRouterV2.recruiterRewardsVault", await router.recruiterRewardsVault(), contracts.RecruiterRewardsVault);
  assertEq("TreasuryRouterV2.communityRewardsVault", await router.communityRewardsVault(), contracts.CommunityRewardsVault);
  assertEq("TreasuryRouterV2.protocolRevenueVault", await router.protocolRevenueVault(), contracts.ProtocolRevenueVault);

  if (deployment.routing?.permanentLpLockerAuthorized === true) {
    assertEq("TreasuryRouterV2.permanentLpLocker", await router.permanentLpLocker(), contracts.PermanentLpLocker);
    assertTrue("TreasuryRouterV2.authorizedLpLocker", await router.authorizedLpLocker(contracts.PermanentLpLocker));
  }

  await verifyMonthlyLeagueTreasury(deployment, contracts);
}

export async function verifyDeployment(deployment: any) {
  const contracts = resolveContracts(deployment);
  const v2Deployment = isTreasuryRouterV2Deployment(deployment, contracts);
  const optionalV2Contracts = new Set(["TreasuryRouterV2", "WeeklyLeagueVault", "MonthlyLeagueTreasury", "CharityTreasury"]);

  for (const [name, address] of Object.entries(contracts)) {
    if (!v2Deployment && optionalV2Contracts.has(name)) continue;
    await assertCode(name, address);
  }

  const router = deployment.productionTopazRouter || deployment.topazInfrastructure?.contracts?.Router || deployment.topazRouter || deployment.router;
  await assertTopazRouter("TopazRouter", router);

  if (deployment.graduationPriceFeed) {
    await assertCode("GraduationPriceFeed", deployment.graduationPriceFeed);
  }

  if (deployment.routing?.factoryFeeRecipient) {
    assertEq("routing.factoryFeeRecipient", deployment.routing.factoryFeeRecipient, contracts.TreasuryRouter);
  }
  if (deployment.routing?.permanentLpLocker) {
    assertEq("routing.permanentLpLocker", deployment.routing.permanentLpLocker, contracts.PermanentLpLocker);
  }
  if (deployment.routing?.campaignImplementation) {
    assertEq("routing.campaignImplementation", deployment.routing.campaignImplementation, contracts.LaunchCampaignImplementation);
  }
  if (deployment.routing?.graduationOracle) {
    assertEq("routing.graduationOracle", deployment.routing.graduationOracle, contracts.GraduationOracle);
  }
  if (deployment.routing?.charityTreasury) {
    assertEq("routing.charityTreasury", deployment.routing.charityTreasury, contracts.CharityTreasury);
  }

  if (deployment.routing?.unifiedRouterModeActive !== undefined) {
    assertTrue("routing.unifiedRouterModeActive", Boolean(deployment.routing.unifiedRouterModeActive));
  }

  if (v2Deployment) {
    await verifyTreasuryRouterV2(deployment, contracts);
  }

  console.log("[verify] deployment wiring OK");
}

async function main() {
  await verifyDeployment(loadDeployment());
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
