#!/usr/bin/env node
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const EXPECTED_FACTORY_GENERATION = 4;
export const EXPECTED_CAMPAIGN_GENERATION = 3;
export const EXPECTED_LIQUIDITY_KIND = 2;

const REQUIRED_CONTRACTS = [
  "launchFactory",
  "launchCampaignImplementation",
  "permanentV3PositionLocker",
  "treasuryRouterV3",
  "graduationAdapter",
  "v3NativeSwapAdapter",
  "stockGraduationAdapter",
  "v3MultiHopSwapAdapter",
  "graduationOracle",
  "creatorRegistry",
  "riskRegistry",
  "weeklyLeagueVault",
  "recruiterRewardsVault",
  "communityRewardsVault",
  "protocolRevenueVault",
  "upVoteTreasury",
  "v3Factory",
  "nonfungiblePositionManager",
  "v3SwapRouter",
  "weth9",
];

const DARK_FLAGS = [
  "supportEnabled",
  "creationEnabled",
  "stockMarketsEnabled",
  "stockGraduationEnabled",
  "stockEthRoutingEnabled",
  "stockMarketUiEnabled",
  "beatTheMarketEnabled",
];

function normalizeAddress(value) {
  const raw = String(value || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw) || /^0x0{40}$/i.test(raw)) return null;
  return raw.toLowerCase();
}

function requireAddress(value, label) {
  const normalized = normalizeAddress(value);
  if (!normalized) throw new Error(`${label} is missing, zero, or invalid`);
  return normalized;
}

function normalizedAddressSet(contracts = {}) {
  return new Set(
    Object.values(contracts)
      .map((value) => normalizeAddress(value))
      .filter(Boolean),
  );
}

function sha(value) {
  const raw = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(raw) ? raw : null;
}

export function proveRobinhoodProductionManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== "object") throw new Error("production manifest is missing");
  const acceptedTestnet = options.acceptedTestnet || null;
  const expectedCandidateSha = sha(options.candidateSha);

  const chainId = Number(manifest.targetChainId ?? manifest.chainId);
  if (chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
    throw new Error(`wrong Robinhood production chain: expected ${ROBINHOOD_MAINNET_CHAIN_ID}, got ${chainId}`);
  }
  if (String(manifest.chainKey || "").toLowerCase() !== "robinhood-mainnet") {
    throw new Error("production manifest chainKey must be robinhood-mainnet");
  }
  if (String(manifest.environment || "").toLowerCase() !== "production") {
    throw new Error("production manifest must declare environment=production");
  }
  if (!Number.isInteger(Number(manifest.deploymentBlock)) || Number(manifest.deploymentBlock) <= 0) {
    throw new Error("production deploymentBlock must be a positive integer");
  }

  if (
    Number(manifest.factoryGeneration) !== EXPECTED_FACTORY_GENERATION ||
    Number(manifest.campaignGeneration) !== EXPECTED_CAMPAIGN_GENERATION ||
    Number(manifest.liquidityKind) !== EXPECTED_LIQUIDITY_KIND
  ) {
    throw new Error(
      `wrong production generation/liquidity metadata: expected factory ${EXPECTED_FACTORY_GENERATION} / campaign ${EXPECTED_CAMPAIGN_GENERATION} / liquidity ${EXPECTED_LIQUIDITY_KIND}`,
    );
  }

  const manifestSha = sha(manifest.sourceSha ?? manifest.candidateSha ?? manifest.buildSha);
  if (!manifestSha) throw new Error("production manifest must record a full 40-character sourceSha");
  if (expectedCandidateSha && manifestSha !== expectedCandidateSha) {
    throw new Error(`production sourceSha mismatch: expected ${expectedCandidateSha}, got ${manifestSha}`);
  }

  if (manifest.productionCompatible !== true) {
    throw new Error("production manifest must explicitly declare productionCompatible=true");
  }
  if (manifest.testnetOnly === true || manifest.stagingOnly) {
    throw new Error("production manifest contains testnet/staging-only metadata");
  }

  for (const flag of DARK_FLAGS) {
    if (manifest[flag] !== false) throw new Error(`production preflight requires ${flag}=false`);
  }
  if (manifest.factoryLive !== false || manifest.createPaused !== true) {
    throw new Error("production preflight requires factoryLive=false and createPaused=true");
  }
  if (manifest.securityDefaultsLocked !== true) {
    throw new Error("production preflight requires securityDefaultsLocked=true");
  }
  if (manifest.requireRouteAuthorization !== true || manifest.requireAuthorizedTrading !== true) {
    throw new Error("production preflight requires route and trading authorization");
  }

  const contracts = manifest.contracts || {};
  const productionAddresses = new Map();
  for (const key of REQUIRED_CONTRACTS) {
    const address = requireAddress(contracts[key], `contracts.${key}`);
    if (productionAddresses.has(address)) {
      throw new Error(`production contracts ${productionAddresses.get(address)} and ${key} reuse ${address}`);
    }
    productionAddresses.set(address, key);
  }

  if (acceptedTestnet) {
    const testnetChainId = Number(acceptedTestnet.chainId ?? acceptedTestnet.targetChainId);
    if (testnetChainId !== ROBINHOOD_TESTNET_CHAIN_ID) {
      throw new Error("accepted testnet manifest must be chain 46630");
    }
    const forbidden = normalizedAddressSet(acceptedTestnet.contracts || {});
    for (const [address, key] of productionAddresses) {
      if (forbidden.has(address)) {
        throw new Error(`production contract ${key} reuses accepted Robinhood testnet address ${address}`);
      }
    }
  }

  const stock = manifest.stock || {};
  if (stock.canonicalRegistryConfigured !== true) {
    throw new Error("production Stock registry must be explicitly configured before preflight can pass");
  }
  if (stock.nativeUsdOracleConfigured !== true) {
    throw new Error("production native/USD oracle must be explicitly configured before preflight can pass");
  }
  if (stock.approvedAcquisitionRoutesConfigured !== true) {
    throw new Error("production approved Stock acquisition routes must be explicitly configured before preflight can pass");
  }
  if (stock.stockRoutesEnabled === true) {
    throw new Error("production Stock routes must remain disabled during preflight");
  }

  if (!Array.isArray(manifest.activationPrerequisites) || manifest.activationPrerequisites.length < 4) {
    throw new Error("production activationPrerequisites must document oracle, route, canary, and rollback gates");
  }
  const prerequisites = manifest.activationPrerequisites.map((value) => String(value || "").trim().toLowerCase());
  for (const keyword of ["oracle", "route", "canary", "rollback"]) {
    if (!prerequisites.some((value) => value.includes(keyword))) {
      throw new Error(`production activationPrerequisites missing ${keyword} gate`);
    }
  }

  return {
    chainId,
    sourceSha: manifestSha,
    contractCount: productionAddresses.size,
    dark: true,
  };
}

function runningAsCli() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  const manifestFile = process.argv[2] || process.env.ROBINHOOD_PRODUCTION_MANIFEST;
  const acceptedTestnetFile = process.argv[3] || process.env.ROBINHOOD_ACCEPTED_TESTNET_MANIFEST || "deployments/robinhood/testnet.accepted.json";
  const candidateSha = process.argv[4] || process.env.ROBINHOOD_PRODUCTION_CANDIDATE_SHA || process.env.GITHUB_SHA;
  if (!manifestFile) {
    console.error("usage: node scripts/prove-robinhood-production-manifest.mjs <mainnet-manifest.json> [accepted-testnet.json] [candidate-sha]");
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const acceptedTestnet = JSON.parse(fs.readFileSync(acceptedTestnetFile, "utf8"));
  const result = proveRobinhoodProductionManifest(manifest, { acceptedTestnet, candidateSha });
  console.log("Robinhood production manifest preflight passed", result);
}
