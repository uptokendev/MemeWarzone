#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  proveRobinhoodProductionManifest,
  ROBINHOOD_MAINNET_CHAIN_ID,
  EXPECTED_FACTORY_GENERATION,
  EXPECTED_CAMPAIGN_GENERATION,
  EXPECTED_LIQUIDITY_KIND,
} from "./prove-robinhood-production-manifest.mjs";

const REQUIRED_CONTRACTS = [
  "launchFactory",
  "launchCampaignImplementation",
  "stockCampaignImplementation",
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

function fullSha(value, label = "sourceSha") {
  const raw = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(raw)) throw new Error(`${label} must be a full 40-character commit SHA`);
  return raw;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function copyContracts(input = {}) {
  const contracts = {};
  for (const key of REQUIRED_CONTRACTS) contracts[key] = input[key];
  return contracts;
}

function normalizeStockRegistry(registry) {
  if (!Array.isArray(registry)) throw new Error("stock.registry must be an array");
  return registry.map((entry) => ({
    symbol: entry.symbol,
    displayName: entry.displayName,
    underlyingSymbol: entry.underlyingSymbol,
    decimals: entry.decimals,
    contractAddress: entry.contractAddress,
    oracleFeedAddress: entry.oracleFeedAddress,
    oracleType: entry.oracleType,
    canonical: entry.canonical === true,
    enabledForDiscovery: entry.enabledForDiscovery === true,
    enabledForGraduation: false,
    enabledForTrading: false,
    minimumQuoteLiquidityUsd: entry.minimumQuoteLiquidityUsd,
    maximumGraduationSwapImpactBps: entry.maximumGraduationSwapImpactBps,
    acquisitionPoolAddress: entry.acquisitionPoolAddress,
    acquisitionQuoterAddress: entry.acquisitionQuoterAddress,
    acquisitionRouterAddress: entry.acquisitionRouterAddress,
    acquisitionFeeTier: entry.acquisitionFeeTier,
    acquisitionQuoteKind: entry.acquisitionQuoteKind,
  }));
}

export function buildRobinhoodProductionManifest(inventory, options = {}) {
  if (!inventory || typeof inventory !== "object") throw new Error("production inventory is missing");
  const sourceSha = fullSha(options.candidateSha || inventory.sourceSha || inventory.candidateSha);
  const deploymentBlock = positiveInteger(inventory.deploymentBlock, "deploymentBlock");

  const manifest = {
    schemaVersion: 2,
    kind: "robinhood-production-preflight",
    chainKey: "robinhood-mainnet",
    chainId: ROBINHOOD_MAINNET_CHAIN_ID,
    targetChainId: ROBINHOOD_MAINNET_CHAIN_ID,
    environment: "production",
    sourceSha,
    deploymentBlock,
    factoryGeneration: EXPECTED_FACTORY_GENERATION,
    campaignGeneration: EXPECTED_CAMPAIGN_GENERATION,
    liquidityKind: EXPECTED_LIQUIDITY_KIND,
    productionCompatible: true,
    testnetOnly: false,

    // RH-S14 preflight is intentionally dark. Activation is a separate operation.
    supportEnabled: false,
    creationEnabled: false,
    stockMarketsEnabled: false,
    stockGraduationEnabled: false,
    stockEthRoutingEnabled: false,
    stockMarketUiEnabled: false,
    beatTheMarketEnabled: false,
    factoryLive: false,
    createPaused: true,
    securityDefaultsLocked: true,
    requireRouteAuthorization: true,
    requireAuthorizedTrading: true,

    admin: inventory.admin,
    routeAuthority: inventory.routeAuthority,
    contracts: copyContracts(inventory.contracts),
    oracles: {
      nativeUsdFeed: inventory.oracles?.nativeUsdFeed,
    },
    stock: {
      canonicalRegistryConfigured: true,
      nativeUsdOracleConfigured: true,
      approvedAcquisitionRoutesConfigured: true,
      stockRoutesEnabled: false,
      registry: normalizeStockRegistry(inventory.stock?.registry),
    },
    activationPrerequisites: [
      "verify production oracle freshness and feed identity",
      "verify approved Stock route liquidity and route health",
      "complete mainnet canary with creation and public Stock surfaces still disabled",
      "prove rollback and feature-disable procedure before activation",
    ],
    generatedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
  };

  proveRobinhoodProductionManifest(manifest, {
    acceptedTestnet: options.acceptedTestnet,
    candidateSha: sourceSha,
  });
  return manifest;
}

function runningAsCli() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
}

if (runningAsCli()) {
  const inventoryFile = process.argv[2] || process.env.ROBINHOOD_PRODUCTION_INVENTORY;
  const outputFile = process.argv[3] || process.env.ROBINHOOD_PRODUCTION_MANIFEST || "deployments/robinhood/mainnet.candidate.json";
  const acceptedFile = process.env.ROBINHOOD_ACCEPTED_TESTNET_MANIFEST || "deployments/robinhood/testnet.accepted.json";
  const candidateSha = process.argv[4] || process.env.ROBINHOOD_PRODUCTION_CANDIDATE_SHA || process.env.GITHUB_SHA;

  if (!inventoryFile) {
    console.error("usage: node scripts/prepare-robinhood-production-manifest.mjs <production-inventory.json> [output.json] [candidate-sha]");
    process.exit(2);
  }

  const inventory = JSON.parse(fs.readFileSync(inventoryFile, "utf8"));
  const acceptedTestnet = JSON.parse(fs.readFileSync(acceptedFile, "utf8"));
  const manifest = buildRobinhoodProductionManifest(inventory, { acceptedTestnet, candidateSha });
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Robinhood production preflight candidate written to ${outputFile}`);
  console.log({ chainId: manifest.chainId, sourceSha: manifest.sourceSha, deploymentBlock: manifest.deploymentBlock, dark: true });
}
