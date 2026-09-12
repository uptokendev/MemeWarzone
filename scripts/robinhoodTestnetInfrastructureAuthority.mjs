#!/usr/bin/env node

export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const LOCAL_REHEARSAL_CHAIN_ID = 31337;
export const INFRA_MANIFEST_SCHEMA_VERSION = 2;
export const INFRA_MANIFEST_PATH = "deployments/robinhood/testnet.infrastructure.json";
export const INFRA_BROADCAST_TOKEN = "DEPLOY_CHAIN_46630_TESTNET_INFRA";
export const V3_FEE_TIER = 3000;
export const SWAP_ROUTER02_EXACT_INPUT_SINGLE_SELECTOR = "04e45aaf";
export const LEGACY_V3_EXACT_INPUT_SINGLE_SELECTOR = "414bf389";

export const BOOTSTRAP_SOURCE_IDENTITIES = Object.freeze({
  wrappedNative: "canonical-weth9-behavior/mwz-rh46630-v1",
  v3Core: "@uniswap/v3-core@1.0.1",
  v3Periphery: "@uniswap/v3-periphery@1.4.4",
  swapRouter02: "@uniswap/swap-router-contracts@1.3.1",
  oracle: "mwz-rh46630-eth-usd-aggregator-v1",
});

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const CORE_DEPLOYMENT_NAMES = Object.freeze(["weth", "v3Factory", "positionManager", "swapRouter02", "oracle"]);
const PERIPHERY_DEPENDENCY_NAMES = Object.freeze(["nftDescriptor", "tokenDescriptor"]);

export function sameAddress(a, b) {
  return Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();
}

export function requireAddress(label, value) {
  const text = String(value || "").trim();
  if (!ADDRESS_RE.test(text) || sameAddress(text, ZERO)) throw new Error(`${label} must be a non-zero address`);
  return text;
}

export function validateBootstrapBoundary({ chainId, networkName, broadcastToken, manifestExists = false }) {
  if (Number(chainId) === ROBINHOOD_MAINNET_CHAIN_ID) throw new Error("Robinhood production chain 4663 is forbidden for testnet infrastructure bootstrap");
  if (Number(chainId) !== ROBINHOOD_TESTNET_CHAIN_ID || networkName !== "robinhoodTestnet") throw new Error(`bootstrap requires robinhoodTestnet / ${ROBINHOOD_TESTNET_CHAIN_ID}`);
  const broadcast = String(broadcastToken || "") === INFRA_BROADCAST_TOKEN;
  if (broadcast && manifestExists) throw new Error("Robinhood testnet infrastructure manifest already exists; refusing overwrite");
  return { chainId: ROBINHOOD_TESTNET_CHAIN_ID, broadcast };
}

export function validateLocalRehearsalBoundary(chainId, allowLocalRehearsal) {
  if (Number(chainId) === ROBINHOOD_MAINNET_CHAIN_ID) throw new Error("Robinhood production chain 4663 is forbidden");
  if (Number(chainId) === ROBINHOOD_TESTNET_CHAIN_ID) return true;
  if (allowLocalRehearsal === true && Number(chainId) === LOCAL_REHEARSAL_CHAIN_ID) return true;
  throw new Error(`unsupported infrastructure rehearsal chain ${chainId}`);
}

export function requireRuntimeCode(label, code) {
  const normalized = String(code || "").toLowerCase();
  if (!normalized || normalized === "0x" || normalized === "0x0") throw new Error(`${label} has no runtime bytecode`);
  return normalized;
}

export function requireSwapRouter02Runtime(code) {
  const runtime = requireRuntimeCode("swapRouter02", code).replace(/^0x/, "");
  if (!runtime.includes(SWAP_ROUTER02_EXACT_INPUT_SINGLE_SELECTOR)) throw new Error("swap router does not expose SwapRouter02 no-deadline exactInputSingle selector 0x04e45aaf");
  return true;
}

export function requireBoundAddress(label, actual, expected) {
  requireAddress(`${label} actual`, actual);
  requireAddress(`${label} expected`, expected);
  if (!sameAddress(actual, expected)) throw new Error(`${label} binding mismatch: ${actual} != ${expected}`);
  return true;
}

export function validateOracleObservation({ decimals, roundId, answer, updatedAt, answeredInRound, currentTimestamp, maxAgeSeconds }) {
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 1 || d > 18) throw new Error(`oracle decimals unsupported: ${decimals}`);
  const rid = BigInt(roundId), ans = BigInt(answer), updated = BigInt(updatedAt), answered = BigInt(answeredInRound), now = BigInt(currentTimestamp), maxAge = BigInt(maxAgeSeconds);
  if (rid <= 0n || ans <= 0n || updated <= 0n || answered < rid) throw new Error("native/USD oracle round is invalid");
  if (now < updated) throw new Error("native/USD oracle timestamp is in the future");
  if (now - updated > maxAge) throw new Error("native/USD oracle is stale");
  return true;
}

function requireReceipt(name, entry) {
  if (!entry || typeof entry !== "object") throw new Error(`${name} deployment receipt missing`);
  requireAddress(`${name}.address`, entry.address);
  if (!HASH_RE.test(String(entry.txHash || ""))) throw new Error(`${name}.txHash invalid`);
  if (!Number.isInteger(Number(entry.blockNumber)) || Number(entry.blockNumber) <= 0) throw new Error(`${name}.blockNumber invalid`);
  if (!HASH_RE.test(String(entry.runtimeCodeHash || ""))) throw new Error(`${name}.runtimeCodeHash invalid`);
}

export function buildInfrastructureManifest(input) {
  if (Number(input.chainId) !== ROBINHOOD_TESTNET_CHAIN_ID) throw new Error("manifest chain must be 46630");
  const deployer = requireAddress("deployer", input.deployer);
  const oracleUpdater = requireAddress("oracleUpdater", input.oracleUpdater);
  for (const name of CORE_DEPLOYMENT_NAMES) requireReceipt(name, input.deployments?.[name]);
  for (const name of PERIPHERY_DEPENDENCY_NAMES) requireReceipt(`peripheryDependencies.${name}`, input.peripheryDependencies?.[name]);
  if (Number(input.feeTier) !== V3_FEE_TIER || BigInt(input.feeTickSpacing) <= 0n) throw new Error("fee 3000 proof missing");
  requireBoundAddress("NPM factory", input.bindings?.npmFactory, input.deployments.v3Factory.address);
  requireBoundAddress("NPM WETH9", input.bindings?.npmWeth9, input.deployments.weth.address);
  requireBoundAddress("router factory", input.bindings?.routerFactory, input.deployments.v3Factory.address);
  requireBoundAddress("router WETH9", input.bindings?.routerWeth9, input.deployments.weth.address);
  validateOracleObservation({ decimals: input.oracle?.decimals, roundId: input.oracle?.roundId, answer: input.oracle?.answer, updatedAt: input.oracle?.updatedAt, answeredInRound: input.oracle?.answeredInRound, currentTimestamp: input.oracle?.certifiedAtTimestamp, maxAgeSeconds: input.oracle?.maxAgeSeconds });

  const allReceipts = [...CORE_DEPLOYMENT_NAMES.map((name) => input.deployments[name]), ...PERIPHERY_DEPENDENCY_NAMES.map((name) => input.peripheryDependencies[name])];
  const blocks = allReceipts.map((entry) => Number(entry.blockNumber));
  return {
    schemaVersion: INFRA_MANIFEST_SCHEMA_VERSION,
    kind: "robinhood-testnet-46630-infrastructure-bootstrap",
    chainId: ROBINHOOD_TESTNET_CHAIN_ID,
    environment: "testnet-only",
    productionChainId: ROBINHOOD_MAINNET_CHAIN_ID,
    productionCompatible: false,
    sourceSha: String(input.sourceSha || "unknown"),
    sourceIdentities: BOOTSTRAP_SOURCE_IDENTITIES,
    deployedAt: input.deployedAt || new Date().toISOString(),
    deploymentBlock: Math.min(...blocks),
    completionBlock: Math.max(...blocks),
    deployer,
    weth: input.deployments.weth,
    v3Factory: input.deployments.v3Factory,
    peripheryDependencies: { nftDescriptor: input.peripheryDependencies.nftDescriptor, tokenDescriptor: input.peripheryDependencies.tokenDescriptor },
    fee3000: { enabled: true, tickSpacing: Number(input.feeTickSpacing) },
    positionManager: input.deployments.positionManager,
    swapRouter02: input.deployments.swapRouter02,
    oracle: { ...input.deployments.oracle, updater: oracleUpdater, decimals: Number(input.oracle.decimals), lastCertifiedRound: String(input.oracle.roundId), lastCertifiedAnswer: String(input.oracle.answer), lastCertifiedTimestamp: Number(input.oracle.updatedAt), answeredInRound: String(input.oracle.answeredInRound), maxAgeSeconds: Number(input.oracle.maxAgeSeconds) },
    bindings: { npmFactory: input.bindings.npmFactory, npmWeth9: input.bindings.npmWeth9, routerFactory: input.bindings.routerFactory, routerWeth9: input.bindings.routerWeth9 },
    deploymentTransactions: Object.fromEntries(CORE_DEPLOYMENT_NAMES.map((name) => [name, { txHash: input.deployments[name].txHash, blockNumber: Number(input.deployments[name].blockNumber) }])),
    mwzEnvironment: {
      ROBINHOOD_WETH_ADDRESS_46630: input.deployments.weth.address,
      ROBINHOOD_V3_FACTORY_ADDRESS_46630: input.deployments.v3Factory.address,
      ROBINHOOD_V3_POSITION_MANAGER_ADDRESS_46630: input.deployments.positionManager.address,
      ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630: input.deployments.swapRouter02.address,
      ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_46630: input.deployments.oracle.address,
    },
  };
}

export function validateInfrastructureManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== INFRA_MANIFEST_SCHEMA_VERSION) throw new Error("wrong infrastructure manifest schema");
  if (manifest.kind !== "robinhood-testnet-46630-infrastructure-bootstrap") throw new Error("wrong infrastructure manifest kind");
  if (manifest.chainId !== ROBINHOOD_TESTNET_CHAIN_ID || manifest.environment !== "testnet-only") throw new Error("wrong infrastructure network identity");
  if (manifest.productionCompatible !== false || manifest.productionChainId !== ROBINHOOD_MAINNET_CHAIN_ID) throw new Error("production isolation marker invalid");
  for (const name of CORE_DEPLOYMENT_NAMES) requireReceipt(name, manifest[name]);
  for (const name of PERIPHERY_DEPENDENCY_NAMES) requireReceipt(`peripheryDependencies.${name}`, manifest.peripheryDependencies?.[name]);
  if (manifest.fee3000?.enabled !== true || Number(manifest.fee3000?.tickSpacing) <= 0) throw new Error("fee 3000 proof missing");
  requireBoundAddress("manifest NPM factory", manifest.bindings?.npmFactory, manifest.v3Factory.address);
  requireBoundAddress("manifest NPM WETH9", manifest.bindings?.npmWeth9, manifest.weth.address);
  requireBoundAddress("manifest router factory", manifest.bindings?.routerFactory, manifest.v3Factory.address);
  requireBoundAddress("manifest router WETH9", manifest.bindings?.routerWeth9, manifest.weth.address);
  requireAddress("manifest oracle updater", manifest.oracle?.updater);
  return true;
}
