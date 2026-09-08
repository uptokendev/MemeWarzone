#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const LOCAL_HARDHAT_CHAIN_ID = 31337;
export const ACCEPTED_5B_SHA = "d1783b4d31133bfcb107d1d32e04047c9e827fbf";
export const FREEZE_KIND = "robinhood-testnet-acceptance-freeze";

function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function freezePath() {
  return path.join(repoRoot(), "deployments/robinhood/testnet.accepted.json");
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

function sameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

export function parseRobinhoodTestnetFreeze(raw) {
  if (raw == null || typeof raw !== "object") throw new Error("Robinhood freeze is missing or not an object");
  if (Number(raw.schemaVersion) !== 1) throw new Error("Robinhood freeze schemaVersion must be 1");
  if (raw.kind !== FREEZE_KIND) throw new Error(`Robinhood freeze kind must be ${FREEZE_KIND}`);
  if (Number(raw.chainId) !== ROBINHOOD_TESTNET_CHAIN_ID) {
    throw new Error(`Robinhood freeze chainId must be ${ROBINHOOD_TESTNET_CHAIN_ID}`);
  }
  if (String(raw.accepted5BSha || "").toLowerCase() !== ACCEPTED_5B_SHA.toLowerCase()) {
    throw new Error(`Robinhood freeze accepted5BSha must be ${ACCEPTED_5B_SHA}`);
  }
  if (!isAddress(raw.factory) || !isAddress(raw.routeAuthority) || !isAddress(raw.admin)) {
    throw new Error("Robinhood freeze factory, routeAuthority, and admin must be valid addresses");
  }
  if (sameAddress(raw.routeAuthority, raw.admin)) {
    throw new Error("Robinhood freeze routeAuthority must differ from admin");
  }
  if (Number(raw.factoryGeneration) !== 4 || Number(raw.campaignGeneration) !== 3) {
    throw new Error("Robinhood freeze generations must be factory 4 / campaign 3");
  }
  if (Number(raw.factoryStartBlock) !== 110723466) {
    throw new Error("Robinhood freeze factoryStartBlock must be 110723466");
  }
  if (raw.expectedLive !== true) throw new Error("Robinhood freeze expectedLive must be true");
  if (raw.expectedCreatePaused !== true) throw new Error("Robinhood freeze expectedCreatePaused must be true");
  if (raw.productionCompatible !== false) throw new Error("Robinhood freeze productionCompatible must be false");
  if (raw.productionCreationEnabled !== false) throw new Error("Robinhood freeze productionCreationEnabled must be false");
  const factoryFromContracts = raw.contracts?.launchFactory;
  if (factoryFromContracts && !sameAddress(factoryFromContracts, raw.factory)) {
    throw new Error("Robinhood freeze contracts.launchFactory must match factory");
  }
  return raw;
}

export function loadRobinhoodTestnetFreeze() {
  const file = freezePath();
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Robinhood freeze exists but is not valid JSON: ${error.message}`);
  }
  return parseRobinhoodTestnetFreeze(parsed);
}

export function requireRobinhoodTestnetFreeze() {
  const freeze = loadRobinhoodTestnetFreeze();
  if (!freeze) throw new Error(`Robinhood freeze missing: ${freezePath()}`);
  return freeze;
}

export function assertRobinhoodTestnetMutationForbidden(chainId) {
  const id = Number(chainId);
  if (id !== ROBINHOOD_TESTNET_CHAIN_ID) return;
  const freeze = loadRobinhoodTestnetFreeze();
  if (!freeze) return;
  throw new Error(
    `Robinhood 5C freeze forbids 46630 staged redeploy, lifecycle unpause, and route-authority retarget. ` +
      `Accepted factory ${freeze.factory} is frozen. A later replacement requires a new generation/factory cut.`,
  );
}

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot(), relativePath), "utf8");
}

function requireIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) throw new Error(`${label} is missing required proof text: ${needle}`);
}

export function proveProductionRobinhoodDisabled() {
  const productionEnv = readRepoFile("config/robinhood-production.env.example");
  requireIncludes(productionEnv, "ENABLE_ROBINHOOD_CREATION=false", "production env");
  requireIncludes(productionEnv, "VITE_ENABLE_DIRECT_ROBINHOOD_DEPLOY=false", "production env");
  requireIncludes(productionEnv, "ENABLE_ROBINHOOD_V3_POOL_INDEXER=0", "production env");

  const stagingEnv = readRepoFile("config/robinhood-staging.env.example");
  requireIncludes(stagingEnv, "ENABLE_ROBINHOOD_CREATION=false", "staging env");
  requireIncludes(stagingEnv, "VITE_ENABLE_DIRECT_ROBINHOOD_DEPLOY=false", "staging env");
  requireIncludes(stagingEnv, "ENABLE_ROBINHOOD_V3_POOL_INDEXER=0", "staging env");

  const createPage = readRepoFile("frontend/src/pages/Create.tsx");
  requireIncludes(
    createPage,
    "readFlag(import.meta.env.VITE_ENABLE_DIRECT_ROBINHOOD_DEPLOY, false)",
    "Create.tsx",
  );

  const adapter = readRepoFile("frontend/src/lib/evmChainAdapter.ts");
  requireIncludes(adapter, "export const ACTIVE_EVM_CHAIN_IDS: readonly ActiveEvmChainId[] = [56, 97] as const", "evmChainAdapter");
  requireIncludes(adapter, "export type ActiveEvmChainId = 56 | 97", "evmChainAdapter");

  const indexer = readRepoFile("realtime-indexer/src/evmIndexerChains.ts");
  requireIncludes(
    indexer,
    "export const ACTIVE_EVM_INDEXER_CHAIN_IDS: readonly EvmIndexerChainId[] = [56, 97] as const",
    "evmIndexerChains",
  );

  const indexerEnv = readRepoFile("realtime-indexer/src/env.ts");
  requireIncludes(indexerEnv, 'ENABLE_ROBINHOOD_V3_POOL_INDEXER: String(process.env.ENABLE_ROBINHOOD_V3_POOL_INDEXER || "0") === "1"', "indexer env");

  const testnetPlaceholder = JSON.parse(readRepoFile("deployments/robinhood/testnet.json"));
  const mainnetPlaceholder = JSON.parse(readRepoFile("deployments/robinhood/mainnet.json"));
  if (testnetPlaceholder.creationEnabled !== false || Object.keys(testnetPlaceholder.contracts || {}).length) {
    throw new Error("deployments/robinhood/testnet.json must stay empty and creation-disabled");
  }
  if (mainnetPlaceholder.chainId !== ROBINHOOD_MAINNET_CHAIN_ID || mainnetPlaceholder.creationEnabled !== false) {
    throw new Error("deployments/robinhood/mainnet.json must stay production-disabled");
  }
  if (Object.keys(mainnetPlaceholder.contracts || {}).length) {
    throw new Error("deployments/robinhood/mainnet.json must not expose production contracts");
  }

  const registry = readRepoFile("frontend/src/lib/chainRegistry.ts");
  if (!/robinhood-mainnet[\s\S]*?chainId:\s*4663[\s\S]*?supportsCreation:\s*false/.test(registry)) {
    throw new Error("chainRegistry production Robinhood must keep supportsCreation false");
  }
  if (/robinhood-mainnet[\s\S]*?supportsCreation:\s*true/.test(registry.split("robinhood-testnet")[0] || "")) {
    throw new Error("chainRegistry production Robinhood must not enable creation");
  }

  return {
    productionCreationEnabled: false,
    directRobinhoodDeployEnabled: false,
    activeEvmChainIds: [56, 97],
    activeEvmIndexerChainIds: [56, 97],
    robinhoodV3PoolIndexerDefault: 0,
    productionContractsEmpty: true,
  };
}

export function proveFreezeMutationGuardsInSource() {
  const files = [
    "scripts/deploy-robinhood-testnet-stage.ts",
    "scripts/test-robinhood-testnet-lifecycle.ts",
    "scripts/set-robinhood-testnet-route-authority.ts",
  ];
  for (const file of files) {
    const source = readRepoFile(file);
    requireIncludes(source, "assertRobinhoodTestnetMutationForbidden", file);
  }
  return { guarded: files };
}

function runningAsCli() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  requireRobinhoodTestnetFreeze();
  proveProductionRobinhoodDisabled();
  proveFreezeMutationGuardsInSource();
  console.log("Robinhood 5C freeze source proof passed");
}
