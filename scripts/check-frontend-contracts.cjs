#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { buildFrontendEnv } = require("./lib/frontendEnv.cjs");

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const NETWORK_BY_CHAIN_ID = new Map([
  ["56", "bscMainnet"],
  ["97", "bscTestnet"],
]);

const REQUIRED_DEPLOYMENT_CONTRACTS = [
  ["LaunchFactory", ["factory", "factoryAddress"]],
  ["LaunchCampaignImplementation", ["campaignImplementation"]],
  ["TreasuryRouter", ["TreasuryRouterV2", "treasuryRouterV2", "treasuryRouter", "leagueRouter", "routerAddress"]],
  ["TreasuryVaultV2", ["LeagueTreasury", "leagueTreasury", "treasuryVault", "vault"]],
  ["RecruiterRewardsVault", ["recruiterRewardsVault", "recruiterVault"]],
  ["CommunityRewardsVault", ["communityRewardsVault", "communityVault"]],
  ["ProtocolRevenueVault", ["protocolRevenueVault", "protocolVault"]],
  ["CreatorRegistry", ["creatorRegistry"]],
  ["RiskRegistry", ["riskRegistry"]],
  ["GraduationOracle", ["graduationOracle"]],
  ["PermanentLpLocker", ["permanentLpLocker"]],
  ["UPVoteTreasury", ["voteTreasury", "voteTreasuryAddress"]],
];

const REQUIRED_ABIS = [
  "LaunchFactory",
  "LaunchCampaign",
  "LaunchToken",
  "GraduationOracle",
  "CreatorRegistry",
  "RiskRegistry",
  "TreasuryRouter",
  "RecruiterRewardsVault",
  "ProtocolRevenueVault",
  "CommunityRewardsVault",
  "TreasuryVaultV2",
  "UPVoteTreasury",
  "PermanentLpLocker",
];

function resolveTarget(rawTarget) {
  const raw = String(rawTarget || process.env.HARDHAT_NETWORK || "hardhat").trim();
  if (NETWORK_BY_CHAIN_ID.has(raw)) return { network: NETWORK_BY_CHAIN_ID.get(raw), chainId: Number(raw) };
  return { network: raw, chainId: raw === "bscTestnet" ? 97 : raw === "bscMainnet" ? 56 : null };
}

function pickAddress(deployment, canonicalName, fallbacks = []) {
  const contracts = deployment.contracts || {};
  for (const key of [canonicalName, ...fallbacks]) {
    if (typeof contracts[key] === "string" && contracts[key]) return contracts[key];
    if (typeof deployment[key] === "string" && deployment[key]) return deployment[key];
  }
  return "";
}

function usesTreasuryRouterV2(deployment) {
  return hasAddress(pickAddress(deployment, "TreasuryRouterV2", ["treasuryRouterV2"]));
}

function parseEnvFile(file) {
  const values = new Map();
  if (!fs.existsSync(file)) return values;

  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    values.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return values;
}

function parseExpectedEnv(output) {
  return output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf("=");
      return [line.slice(0, idx), line.slice(idx + 1)];
    });
}

function hasAddress(value) {
  return ADDRESS_RE.test(String(value || ""));
}

function checkDeploymentContracts(deployment, sourceLabel, errors) {
  for (const [name, fallbacks] of REQUIRED_DEPLOYMENT_CONTRACTS) {
    if (!hasAddress(pickAddress(deployment, name, fallbacks))) {
      errors.push(`${sourceLabel}: ${name} missing or invalid in final deployment manifest.`);
    }
  }
}

function checkAbiFiles(root, deployment, errors) {
  const requiredAbis = usesTreasuryRouterV2(deployment) ? [...REQUIRED_ABIS, "TreasuryRouterV2"] : REQUIRED_ABIS;
  for (const name of requiredAbis) {
    const file = path.join(root, "frontend", "src", "abi", `${name}.json`);
    if (!fs.existsSync(file)) {
      errors.push(`frontend ABI missing: ${path.relative(root, file)}. Run npm run compile:frontend-abis.`);
      continue;
    }

    try {
      const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(artifact.abi)) {
        errors.push(`frontend ABI malformed: ${path.relative(root, file)} does not contain an abi array.`);
      }
    } catch (error) {
      errors.push(`frontend ABI malformed: ${path.relative(root, file)}: ${error.message}`);
    }
  }
}

function checkTopazMetadata(deployment, sourceLabel, targetChainId, errors, warnings) {
  const topazContracts = deployment.topazInfrastructure && deployment.topazInfrastructure.contracts;
  const topazConfig = deployment.topazInfrastructure && deployment.topazInfrastructure.configuration;
  const topazManifest = deployment.topazManifest || {};

  if (!topazContracts) {
    errors.push(`${sourceLabel}: missing topazInfrastructure.contracts from final Topaz-integrated deployment.`);
    return;
  }

  for (const key of ["Router", "PoolFactory", "WBNB"]) {
    if (!hasAddress(topazContracts[key])) errors.push(`${sourceLabel}: missing topazInfrastructure.contracts.${key}.`);
  }

  if (topazContracts.FactoryRegistry && !hasAddress(topazContracts.FactoryRegistry)) {
    errors.push(`${sourceLabel}: invalid topazInfrastructure.contracts.FactoryRegistry.`);
  }
  if (topazContracts.PoolImplementation && !hasAddress(topazContracts.PoolImplementation)) {
    errors.push(`${sourceLabel}: invalid topazInfrastructure.contracts.PoolImplementation.`);
  }

  const expectedVolatileFeeBps = Number(targetChainId) === 97 ? 30 : 100;
  if (Number(topazConfig && topazConfig.volatileFeeBps) !== expectedVolatileFeeBps) {
    errors.push(`${sourceLabel}: Topaz volatile fee must be ${expectedVolatileFeeBps} bps for chain ${targetChainId}.`);
  }
  if (!topazConfig || topazConfig.graduationPoolStable !== false) {
    errors.push(`${sourceLabel}: Topaz graduationPoolStable must be false.`);
  }

  if (!topazManifest.deploymentCommit) {
    warnings.push(`${sourceLabel}: topazManifest.deploymentCommit is blank; fill it before mainnet readiness sign-off.`);
  }
}

function checkFrontendEnvFile(frontendEnvFile, expectedPairs, errors) {
  if (!fs.existsSync(frontendEnvFile)) {
    errors.push(`frontend env file missing: ${frontendEnvFile}. Run npm run frontend:env:bsc-testnet after final deployment.`);
    return;
  }

  const actual = parseEnvFile(frontendEnvFile);
  for (const [name, expected] of expectedPairs) {
    const value = actual.get(name);
    if (value !== expected) {
      errors.push(`${path.basename(frontendEnvFile)}: ${name} must be ${expected || "unset"}, got ${value || "missing"}.`);
    }
  }

  for (const legacy of ["VITE_PANCAKE_ROUTER_ADDRESS", "VITE_PANCAKE_ROUTER_ADDRESS_56", "VITE_PANCAKE_ROUTER_ADDRESS_97"]) {
    if (actual.has(legacy)) errors.push(`${path.basename(frontendEnvFile)}: remove stale ${legacy}; use Topaz router envs.`);
  }
}

function main() {
  const root = process.cwd();
  const target = resolveTarget(process.argv[2]);
  const deploymentFile = process.env.DEPLOYMENT_FILE
    ? path.resolve(process.env.DEPLOYMENT_FILE)
    : path.join(root, "deployments", `${target.network}.json`);
  const frontendEnvFile = process.env.FRONTEND_ENV_FILE
    ? path.resolve(process.env.FRONTEND_ENV_FILE)
    : path.join(path.dirname(deploymentFile), `${target.network}.frontend.env`);

  const errors = [];
  const warnings = [];

  if (!fs.existsSync(deploymentFile)) {
    errors.push(`deployment file missing: ${deploymentFile}`);
  }

  let expectedPairs = [];
  let deployment = null;
  if (!errors.length) {
    try {
      deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
      if (target.chainId && Number(deployment.chainId) !== target.chainId) {
        errors.push(`${deploymentFile}: expected chainId ${target.chainId}, got ${deployment.chainId || "missing"}.`);
      }
      const expectedEnv = buildFrontendEnv(deployment, deploymentFile);
      expectedPairs = parseExpectedEnv(expectedEnv);
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (deployment) {
    checkDeploymentContracts(deployment, deploymentFile, errors);
    checkTopazMetadata(deployment, deploymentFile, target.chainId, errors, warnings);
    checkFrontendEnvFile(frontendEnvFile, expectedPairs, errors);
    checkAbiFiles(root, deployment, errors);
  }

  console.log(`[frontend-contracts] deployment=${deploymentFile}`);
  console.log(`[frontend-contracts] frontendEnv=${frontendEnvFile}`);
  console.log(`[frontend-contracts] expectedEnvEntries=${expectedPairs.length}`);

  for (const warning of warnings) console.warn(`[frontend-contracts] warning: ${warning}`);

  if (errors.length) {
    for (const error of errors) console.error(`[frontend-contracts] error: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("[frontend-contracts] OK");
  }
}

if (require.main === module) main();
