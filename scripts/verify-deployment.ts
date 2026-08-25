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
    // MemeWarzone only accepts the production Topaz volatile 0.30% fee tier.
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
    Boolean(deployment.routing?.charityTreasury)
  );
}

async function assertContractAddress(label: string, address: string) {
  assertAddress(label, address);
  await assertCode(label, address);
}

async function assertOptionalContractAddress(label: string, address: string) {
  if (!address || address === ethers.ZeroAddress) return;
  await assertContractAddress(label, address);
}

async function assertAddressGetter(
  label: string,
  contractAddress: string,
  getter: string,
  expected: string,
) {
  const contract = new ethers.Contract(
    contractAddress,
    [`function ${getter}() view returns (address)`],
    ethers.provider,
  );
  assertEq(`${label}.${getter}`, await contract[getter](), expected);
}

async function assertUintGetter(
  label: string,
  contractAddress: string,
  getter: string,
  expected: bigint,
) {
  const contract = new ethers.Contract(
    contractAddress,
    [`function ${getter}() view returns (uint256)`],
    ethers.provider,
  );
  assertBigIntEq(`${label}.${getter}`, await contract[getter](), expected);
}

export async function verifyDeployment(deploymentFile: string) {
  const resolvedPath = path.resolve(deploymentFile);
  if (!fs.existsSync(resolvedPath)) throw new Error(`Deployment file not found: ${resolvedPath}`);
  const deployment = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  const contracts = resolveContracts(deployment);

  await assertContractAddress("TreasuryVaultV2", contracts.TreasuryVaultV2);
  await assertContractAddress("TreasuryRouter", contracts.TreasuryRouter);
  if (contracts.TreasuryRouterV2) await assertContractAddress("TreasuryRouterV2", contracts.TreasuryRouterV2);
  await assertOptionalContractAddress("WeeklyLeagueVault", contracts.WeeklyLeagueVault);
  await assertOptionalContractAddress("MonthlyLeagueTreasury", contracts.MonthlyLeagueTreasury);
  await assertOptionalContractAddress("CharityTreasury", contracts.CharityTreasury);
  await assertOptionalContractAddress("RecruiterRewardsVault", contracts.RecruiterRewardsVault);
  await assertOptionalContractAddress("CommunityRewardsVault", contracts.CommunityRewardsVault);
  await assertOptionalContractAddress("ProtocolRevenueVault", contracts.ProtocolRevenueVault);
  await assertOptionalContractAddress("CreatorRegistry", contracts.CreatorRegistry);
  await assertOptionalContractAddress("RiskRegistry", contracts.RiskRegistry);
  await assertOptionalContractAddress("GraduationOracle", contracts.GraduationOracle);
  await assertOptionalContractAddress("LaunchCampaignImplementation", contracts.LaunchCampaignImplementation);
  await assertOptionalContractAddress("LaunchFactory", contracts.LaunchFactory);
  await assertOptionalContractAddress("PermanentLpLocker", contracts.PermanentLpLocker);
  await assertOptionalContractAddress("UPVoteTreasury", contracts.UPVoteTreasury);

  const topazRouter =
    pickAddress(deployment, "TopazProductionRouter", ["topazProductionRouter", "topazProductionRouterAddress"]) ||
    pickAddress(deployment, "TopazRouter", ["topazRouter", "topazRouterAddress"]);
  if (topazRouter) await assertTopazRouter("TopazRouter", topazRouter);

  if (isTreasuryRouterV2Deployment(deployment, contracts)) {
    const router = contracts.TreasuryRouterV2 || contracts.TreasuryRouter;
    if (contracts.WeeklyLeagueVault) await assertAddressGetter("TreasuryRouterV2", router, "weeklyLeagueVault", contracts.WeeklyLeagueVault);
    if (contracts.MonthlyLeagueTreasury) await assertAddressGetter("TreasuryRouterV2", router, "monthlyLeagueTreasury", contracts.MonthlyLeagueTreasury);
    if (contracts.RecruiterRewardsVault) await assertAddressGetter("TreasuryRouterV2", router, "recruiterVault", contracts.RecruiterRewardsVault);
    if (contracts.CommunityRewardsVault) await assertAddressGetter("TreasuryRouterV2", router, "communityVault", contracts.CommunityRewardsVault);
    if (contracts.ProtocolRevenueVault) await assertAddressGetter("TreasuryRouterV2", router, "protocolVault", contracts.ProtocolRevenueVault);
    if (contracts.PermanentLpLocker) {
      const locker = new ethers.Contract(
        router,
        ["function authorizedLpLockers(address) view returns (bool)", "function primaryLpLocker() view returns (address)"],
        ethers.provider,
      );
      assertTrue("TreasuryRouterV2.authorizedLpLockers", await locker.authorizedLpLockers(contracts.PermanentLpLocker));
      assertEq("TreasuryRouterV2.primaryLpLocker", await locker.primaryLpLocker(), contracts.PermanentLpLocker);
    }
    if (deployment.routing?.weeklyLeagueBps != null) {
      await assertUintGetter("TreasuryRouterV2", router, "weeklyLeagueBps", BigInt(deployment.routing.weeklyLeagueBps));
    }
    if (deployment.routing?.monthlyLeagueBps != null) {
      await assertUintGetter("TreasuryRouterV2", router, "monthlyLeagueBps", BigInt(deployment.routing.monthlyLeagueBps));
    }
  }

  console.log(`[verify] deployment ${resolvedPath}: ok`);
}

async function main() {
  const deploymentFile = process.env.DEPLOYMENT_FILE || process.argv[2];
  if (!deploymentFile) {
    throw new Error("Usage: hardhat run scripts/verify-deployment.ts --network <network> <deployment-file>");
  }
  await verifyDeployment(deploymentFile);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
