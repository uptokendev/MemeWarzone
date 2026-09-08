import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";
import { loadDeployment, pickAddress, resolveContracts } from "./verify-deployment";

type AuthorityStatus = "accepted" | "incomplete" | "local";

export type AuthorityFinding = {
  key: string;
  expected: string;
  actual: string;
  ok: boolean;
  severity: "error" | "warning";
  detail?: string;
};

export type AuthorityReport = {
  network: string;
  chainId: number;
  status: AuthorityStatus;
  githubMainProtection: "manual";
  expectedSafe: string;
  deployer: string;
  findings: AuthorityFinding[];
  matrix: Record<string, string>;
  errors: string[];
  warnings: string[];
};

const OWNABLE_ABI = ["function owner() view returns (address)"];
const ADMIN_ABI = ["function admin() view returns (address)"];
const MULTISIG_ABI = ["function multisig() view returns (address)"];

function norm(value: string | undefined | null): string {
  if (!value) return ethers.ZeroAddress;
  try {
    return ethers.getAddress(value);
  } catch {
    return String(value);
  }
}

function isZero(value: string | undefined | null): boolean {
  return !value || norm(value) === ethers.ZeroAddress;
}

function same(a: string | undefined | null, b: string | undefined | null): boolean {
  if (isZero(a) || isZero(b)) return false;
  return norm(a) === norm(b);
}

async function readFn(address: string, abi: string[], fn: string): Promise<string> {
  if (isZero(address)) return ethers.ZeroAddress;
  const contract = new ethers.Contract(address, abi, ethers.provider);
  try {
    return norm(await contract[fn]());
  } catch {
    return ethers.ZeroAddress;
  }
}

function addFinding(
  findings: AuthorityFinding[],
  key: string,
  expected: string,
  actual: string,
  ok: boolean,
  severity: "error" | "warning" = "error",
  detail?: string
) {
  findings.push({ key, expected: norm(expected), actual: norm(actual), ok, severity, detail });
}

export async function collectAuthorityMatrix(deployment: any) {
  const contracts = resolveContracts(deployment);
  const expectedSafe = norm(deployment.treasurySafe || deployment.authority?.expectedSafe);
  const deployer = norm(deployment.deployer);

  const factory = contracts.LaunchFactory;
  const creatorRegistry = contracts.CreatorRegistry;
  const riskRegistry = contracts.RiskRegistry;
  const router = contracts.TreasuryRouterV2 || contracts.TreasuryRouter;
  const vault = contracts.TreasuryVaultV2;
  const monthly = contracts.MonthlyLeagueTreasury;
  const recruiter = contracts.RecruiterRewardsVault;
  const community = contracts.CommunityRewardsVault;
  const protocol = contracts.ProtocolRevenueVault;
  const locker = contracts.PermanentLpLocker;
  const creatorRewards = pickAddress(deployment, "CreatorRewardsVault", ["creatorRewardsVault"]);
  const rewardDistributor = pickAddress(deployment, "RewardDistributor", ["rewardDistributor"]);

  const [
    factoryOwner,
    creatorRegistryOwner,
    riskRegistryOwner,
    routerAdmin,
    vaultMultisig,
    monthlyMultisig,
    recruiterAdmin,
    communityAdmin,
    protocolAdmin,
    lockerAdmin,
    creatorRewardsAdmin,
    rewardDistributorOwner,
    rootPoster,
    monthlyRootPoster,
    vaultOperator,
    recruiterOperator,
  ] = await Promise.all([
    readFn(factory, OWNABLE_ABI, "owner"),
    readFn(creatorRegistry, OWNABLE_ABI, "owner"),
    readFn(riskRegistry, OWNABLE_ABI, "owner"),
    readFn(router, ADMIN_ABI, "admin"),
    readFn(vault, MULTISIG_ABI, "multisig"),
    readFn(monthly, MULTISIG_ABI, "multisig"),
    readFn(recruiter, ADMIN_ABI, "admin"),
    readFn(community, ADMIN_ABI, "admin"),
    readFn(protocol, ADMIN_ABI, "admin"),
    readFn(locker, ADMIN_ABI, "admin"),
    creatorRewards ? readFn(creatorRewards, ADMIN_ABI, "admin") : Promise.resolve(ethers.ZeroAddress),
    rewardDistributor ? readFn(rewardDistributor, OWNABLE_ABI, "owner") : Promise.resolve(ethers.ZeroAddress),
    readFn(vault, ["function rootPoster() view returns (address)"], "rootPoster"),
    monthly ? readFn(monthly, ["function rootPoster() view returns (address)"], "rootPoster") : Promise.resolve(ethers.ZeroAddress),
    readFn(vault, ["function operator() view returns (address)"], "operator"),
    recruiter ? readFn(recruiter, ["function operator() view returns (address)"], "operator") : Promise.resolve(ethers.ZeroAddress),
  ]);

  const routeSigner = norm(deployment.routing?.factoryRouteAuthority || deployment.leagueRouteAuthority || process.env.ROUTE_AUTHORITY_ADDRESS);
  const routerVersion = String(deployment.treasuryRouterVersion || (contracts.TreasuryRouterV2 ? "v2" : "v1"));

  return {
    expectedSafe,
    deployer,
    factory,
    factoryOwner,
    creatorRegistryOwner,
    riskRegistryOwner,
    router,
    routerAdmin,
    routerVersion,
    vaultMultisig,
    monthlyMultisig,
    recruiterAdmin,
    communityAdmin,
    protocolAdmin,
    lockerAdmin,
    creatorRewardsAdmin,
    rewardDistributorOwner,
    rootPoster,
    monthlyRootPoster,
    vaultOperator,
    recruiterOperator,
    routeSigner,
    locker,
  };
}

export async function verifyDeploymentAuthority(
  deployment: any,
  opts?: { allowLocalDeployerOwner?: boolean }
): Promise<AuthorityReport> {
  const live = await collectAuthorityMatrix(deployment);
  const contracts = resolveContracts(deployment);
  const findings: AuthorityFinding[] = [];
  const local = network.name === "hardhat" || network.name === "localhost" || opts?.allowLocalDeployerOwner === true;

  const requireSafe = (key: string, actual: string, optional = false) => {
    if (optional && isZero(actual)) {
      addFinding(findings, key, live.expectedSafe, actual, true, "warning", "component not deployed");
      return;
    }
    if (isZero(actual)) {
      addFinding(findings, key, live.expectedSafe, actual, false, "error", "zero address where forbidden");
      return;
    }
    addFinding(findings, key, live.expectedSafe, actual, same(actual, live.expectedSafe), "error", "must be TREASURY_SAFE");
  };

  if (isZero(live.expectedSafe)) {
    addFinding(findings, "treasurySafe", "non-zero Safe", live.expectedSafe, false, "error", "TREASURY_SAFE missing");
  }

  requireSafe("LaunchFactory.owner", live.factoryOwner);
  requireSafe("CreatorRegistry.owner", live.creatorRegistryOwner);
  requireSafe("RiskRegistry.owner", live.riskRegistryOwner);
  requireSafe("TreasuryRouter.admin", live.routerAdmin);
  requireSafe("TreasuryVaultV2.multisig", live.vaultMultisig);
  requireSafe("MonthlyLeagueTreasury.multisig", live.monthlyMultisig, isZero(live.monthlyMultisig) && !contracts.MonthlyLeagueTreasury);
  requireSafe("RecruiterRewardsVault.admin", live.recruiterAdmin);
  requireSafe("CommunityRewardsVault.admin", live.communityAdmin);
  requireSafe("ProtocolRevenueVault.admin", live.protocolAdmin);
  requireSafe("CreatorRewardsVault.admin", live.creatorRewardsAdmin, isZero(live.creatorRewardsAdmin));
  requireSafe("RewardDistributor.owner", live.rewardDistributorOwner, isZero(live.rewardDistributorOwner));

  if (!isZero(live.lockerAdmin) && !same(live.lockerAdmin, live.factory) && !same(live.lockerAdmin, live.expectedSafe)) {
    addFinding(
      findings,
      "PermanentLpLocker.admin",
      live.factory,
      live.lockerAdmin,
      false,
      "error",
      "locker admin must be the factory generation or Safe"
    );
  } else {
    addFinding(findings, "PermanentLpLocker.admin", live.factory, live.lockerAdmin, true, "warning");
  }

  if (!isZero(live.deployer) && same(live.factoryOwner, live.deployer) && !local) {
    addFinding(findings, "LaunchFactory.deployerOwnership", "Safe", live.deployer, false, "error", "deployer EOA still owns LaunchFactory");
  }

  const overlapPairs: Array<[string, string, string, string]> = [
    ["rootPoster", live.rootPoster, "operator", live.vaultOperator],
    ["rootPoster", live.rootPoster, "treasurySafe", live.expectedSafe],
    ["operator", live.vaultOperator, "treasurySafe", live.expectedSafe],
    ["rootPoster", live.rootPoster, "routeSigner", live.routeSigner],
    ["operator", live.vaultOperator, "routeSigner", live.routeSigner],
    ["routeSigner", live.routeSigner, "treasurySafe", live.expectedSafe],
    ["monthlyRootPoster", live.monthlyRootPoster, "operator", live.vaultOperator],
  ];
  for (const [leftName, left, rightName, right] of overlapPairs) {
    if (same(left, right)) {
      addFinding(
        findings,
        `privilegeOverlap.${leftName}.${rightName}`,
        "distinct keys",
        left,
        false,
        local ? "warning" : "error",
        `${leftName} and ${rightName} share ${norm(left)}`
      );
    }
  }

  if (deployment.treasuryRouterVersion === "v3" && !pickAddress(deployment, "TreasuryRouterV3", ["treasuryRouterV3"])) {
    addFinding(findings, "routerGeneration", "v3", "missing TreasuryRouterV3", false, "error", "stale V2/V3 mix");
  }

  const errors = findings.filter((finding) => !finding.ok && finding.severity === "error").map((finding) => `${finding.key}: ${finding.detail || finding.actual}`);
  const warnings = findings.filter((finding) => !finding.ok && finding.severity === "warning").map((finding) => `${finding.key}: ${finding.detail || finding.actual}`);

  let status: AuthorityStatus = "incomplete";
  if (errors.length === 0) {
    status = local && same(live.factoryOwner, live.deployer) ? "local" : "accepted";
  }

  const report: AuthorityReport = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    status,
    githubMainProtection: "manual",
    expectedSafe: live.expectedSafe,
    deployer: live.deployer,
    findings,
    matrix: {
      LaunchFactory: live.factoryOwner,
      CreatorRegistry: live.creatorRegistryOwner,
      RiskRegistry: live.riskRegistryOwner,
      TreasuryRouterAdmin: live.routerAdmin,
      TreasuryVaultV2Multisig: live.vaultMultisig,
      MonthlyLeagueTreasuryMultisig: live.monthlyMultisig,
      RecruiterRewardsVaultAdmin: live.recruiterAdmin,
      CommunityRewardsVaultAdmin: live.communityAdmin,
      ProtocolRevenueVaultAdmin: live.protocolAdmin,
      CreatorRewardsVaultAdmin: live.creatorRewardsAdmin,
      PermanentLpLockerAdmin: live.lockerAdmin,
      RewardDistributorOwner: live.rewardDistributorOwner,
      rootPoster: live.rootPoster,
      payoutOperator: live.vaultOperator,
      routeSigner: live.routeSigner,
    },
    errors,
    warnings,
  };

  return report;
}

export function writeAuthorityReport(report: AuthorityReport) {
  const outDir = path.join(__dirname, "..", "output");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `deployment-authority-${report.network}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

async function main() {
  const deployment = loadDeployment();
  const report = await verifyDeploymentAuthority(deployment);
  const file = writeAuthorityReport(report);
  console.log(`[authority] status=${report.status}`);
  console.log(`[authority] expected Safe=${report.expectedSafe}`);
  console.log(`[authority] github main protection=${report.githubMainProtection} (set this in GitHub before merging to main)`);
  for (const [component, authority] of Object.entries(report.matrix)) {
    console.log(`[authority] ${component}: ${authority}`);
  }
  for (const warning of report.warnings) console.warn(`[authority] warning: ${warning}`);
  console.log(`[authority] wrote ${file}`);
  if (report.errors.length && !(local && report.status === "local")) {
    throw new Error(`Authority verification failed:\n- ${report.errors.join("\n- ")}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
