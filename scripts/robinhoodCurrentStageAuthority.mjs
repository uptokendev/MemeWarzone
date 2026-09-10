#!/usr/bin/env node

export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const CURRENT_FACTORY_GENERATION = 4;
export const CURRENT_CAMPAIGN_GENERATION = 3;
export const CURRENT_LIQUIDITY_KIND = 2;
export const CURRENT_V3_FEE_TIER = 3000;
export const CURRENT_STAGE_MANIFEST_SCHEMA_VERSION = 4;
export const CURRENT_STAGE_MANIFEST_PATH = "deployments/robinhood/testnet.staged.json";
export const BROADCAST_TOKEN = "DEPLOY_CHAIN_46630_CURRENT_STAGE";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const CURRENT_STAGE_REQUIRED_DEPLOYMENTS = [
  "graduationOracle",
  "weeklyLeagueVault",
  "charityTreasury",
  "monthlyLeagueTreasury",
  "recruiterRewardsVault",
  "protocolRevenueVault",
  "treasuryRouterV3",
  "communityRewardsVault",
  "creatorRewardsVault",
  "graduationAdapter",
  "campaignImplementation",
  "creatorRegistry",
  "riskRegistry",
  "launchFactory",
  "permanentV3PositionLocker",
];

export function sameAddress(a, b) {
  return Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();
}

export function isPlaceholder(value) {
  const text = String(value || "").trim();
  return !text || text.includes("<") || text.includes(">") || /placeholder|changeme|example/i.test(text);
}

export function requireAddress(name, value) {
  const text = String(value || "").trim();
  if (isPlaceholder(text) || !ADDRESS_RE.test(text) || sameAddress(text, ZERO_ADDRESS)) {
    throw new Error(`${name} must be an explicit non-placeholder non-zero address`);
  }
  return text;
}

export function requireRpcUrl(value) {
  const text = String(value || "").trim();
  if (isPlaceholder(text)) throw new Error("ROBINHOOD_TESTNET_RPC_URL must be explicit; placeholders are forbidden");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("ROBINHOOD_TESTNET_RPC_URL must be an absolute HTTP(S) URL");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("ROBINHOOD_TESTNET_RPC_URL must use HTTP(S)");
  return text;
}

export function parseMinimumBalanceWei(value, fallbackWei = 50_000_000_000_000_000n) {
  if (value === undefined || value === null || value === "") return fallbackWei;
  const parsed = BigInt(String(value));
  if (parsed <= 0n) throw new Error("minimum deployer balance must be positive");
  return parsed;
}

export function validateOperatorBoundary(input) {
  if (Number(input.chainId) !== ROBINHOOD_TESTNET_CHAIN_ID) {
    throw new Error(`current Robinhood staging deployment requires chain ${ROBINHOOD_TESTNET_CHAIN_ID}`);
  }
  requireRpcUrl(input.rpcUrl);
  const deployer = requireAddress("deployer", input.deployer);
  const admin = requireAddress("ROBINHOOD_TESTNET_ADMIN", input.admin);
  const routeAuthority = requireAddress("ROBINHOOD_ROUTE_AUTHORITY_ADDRESS", input.routeAuthority);
  const weth = requireAddress("ROBINHOOD_WETH_ADDRESS_46630", input.weth);
  const v3Factory = requireAddress("ROBINHOOD_V3_FACTORY_ADDRESS_46630", input.v3Factory);
  const positionManager = requireAddress("ROBINHOOD_V3_POSITION_MANAGER_ADDRESS_46630", input.positionManager);
  const swapRouter = requireAddress("ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_46630", input.swapRouter);
  const nativeUsdOracle = requireAddress("ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_46630", input.nativeUsdOracle);

  if (!sameAddress(deployer, admin)) throw new Error("staging deployer must exactly equal ROBINHOOD_TESTNET_ADMIN");
  if (sameAddress(deployer, routeAuthority)) throw new Error("route/config authority must be distinct from staging deployer/admin");

  const minimumBalanceWei = parseMinimumBalanceWei(input.minimumBalanceWei);
  if (input.deployerBalanceWei !== undefined && BigInt(input.deployerBalanceWei) < minimumBalanceWei) {
    throw new Error(`staging deployer balance below minimum ${minimumBalanceWei}`);
  }

  const infrastructure = { weth, v3Factory, positionManager, swapRouter, nativeUsdOracle };
  const historical = (input.historicalAddresses || []).map((value) => String(value).toLowerCase());
  for (const [name, address] of Object.entries(infrastructure)) {
    if (historical.includes(String(address).toLowerCase())) {
      throw new Error(`${name} reuses a frozen historical 5B/5C contract address`);
    }
  }

  return {
    chainId: ROBINHOOD_TESTNET_CHAIN_ID,
    deployer,
    admin,
    routeAuthority,
    ...infrastructure,
    minimumBalanceWei: minimumBalanceWei.toString(),
    broadcast: String(input.broadcastToken || "") === BROADCAST_TOKEN,
  };
}

export function requireRuntimeCode(label, code) {
  if (!code || code === "0x" || code === "0x0") throw new Error(`${label} has no runtime bytecode`);
  return true;
}

export function requireBoundAddress(label, actual, expected) {
  requireAddress(`${label} actual`, actual);
  requireAddress(`${label} expected`, expected);
  if (!sameAddress(actual, expected)) throw new Error(`${label} binding mismatch: ${actual} != ${expected}`);
  return true;
}

function requireReceipt(name, entry) {
  if (!entry || typeof entry !== "object") throw new Error(`${name} deployment receipt is missing`);
  requireAddress(`${name}.address`, entry.address);
  if (!/^0x[a-fA-F0-9]{64}$/.test(String(entry.txHash || ""))) throw new Error(`${name}.txHash is invalid`);
  if (!Number.isInteger(Number(entry.blockNumber)) || Number(entry.blockNumber) <= 0) throw new Error(`${name}.blockNumber is invalid`);
}

export function buildCurrentStageManifest(input) {
  const operator = validateOperatorBoundary({ ...input.operator, chainId: ROBINHOOD_TESTNET_CHAIN_ID });
  if (!input.deployment || typeof input.deployment !== "object") throw new Error("deployment evidence is missing");
  for (const name of CURRENT_STAGE_REQUIRED_DEPLOYMENTS) requireReceipt(name, input.deployment[name]);
  if (!Array.isArray(input.wiringTransactions) || input.wiringTransactions.length === 0) throw new Error("wiring transaction evidence is missing");
  for (const tx of input.wiringTransactions) {
    if (!/^0x[a-fA-F0-9]{64}$/.test(String(tx.txHash || "")) || !Number.isInteger(Number(tx.blockNumber)) || Number(tx.blockNumber) <= 0) {
      throw new Error("invalid wiring transaction evidence");
    }
  }
  if (input.factoryLive !== false || input.createPaused !== true || input.securityDefaultsLocked !== true) {
    throw new Error("current staging manifest must be dark, create-paused, and security-locked");
  }

  const blockNumbers = CURRENT_STAGE_REQUIRED_DEPLOYMENTS.map((name) => Number(input.deployment[name].blockNumber));
  const deploymentBlock = Math.min(...blockNumbers);
  const completionBlock = Math.max(...blockNumbers, ...input.wiringTransactions.map((tx) => Number(tx.blockNumber)));

  return {
    schemaVersion: CURRENT_STAGE_MANIFEST_SCHEMA_VERSION,
    kind: "robinhood-current-generation-staging-deployment",
    chainKey: "robinhood-testnet",
    chainId: ROBINHOOD_TESTNET_CHAIN_ID,
    nativeAsset: "ETH",
    environment: "staging",
    deployedAt: input.deployedAt || new Date().toISOString(),
    deploymentBlock,
    completionBlock,
    deployer: operator.deployer,
    admin: operator.admin,
    routeAuthority: operator.routeAuthority,
    factoryGeneration: CURRENT_FACTORY_GENERATION,
    campaignGeneration: CURRENT_CAMPAIGN_GENERATION,
    adapterGeneration: "current-robinhood-uniswap-v3-interface",
    lockerGeneration: "current-permanent-v3-position-locker-interface",
    liquidityKind: CURRENT_LIQUIDITY_KIND,
    v3FeeTier: CURRENT_V3_FEE_TIER,
    infrastructure: {
      wrappedNative: operator.weth,
      v3Factory: operator.v3Factory,
      positionManager: operator.positionManager,
      swapRouter: operator.swapRouter,
      nativeUsdOracleFeed: operator.nativeUsdOracle,
    },
    treasury: input.deployment.treasuryRouterV3.address,
    contracts: Object.fromEntries(Object.entries(input.deployment).map(([name, entry]) => [name, entry.address])),
    deploymentTransactions: Object.fromEntries(Object.entries(input.deployment).map(([name, entry]) => [name, { txHash: entry.txHash, blockNumber: Number(entry.blockNumber) }])),
    wiringTransactions: input.wiringTransactions.map((tx) => ({ name: tx.name, txHash: tx.txHash, blockNumber: Number(tx.blockNumber) })),
    state: {
      supportEnabled: false,
      creationEnabled: false,
      factoryLive: false,
      createPaused: true,
      securityDefaultsLocked: true,
      requireAuthorizedTrading: true,
      requireRouteAuthorization: true,
    },
    historicalFreezePreserved: true,
    productionCompatible: false,
    productionChainId: 4663,
  };
}

export function validateCurrentStageManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== CURRENT_STAGE_MANIFEST_SCHEMA_VERSION) throw new Error("wrong current staging manifest schema");
  if (manifest.kind !== "robinhood-current-generation-staging-deployment") throw new Error("wrong current staging manifest kind");
  if (manifest.chainId !== ROBINHOOD_TESTNET_CHAIN_ID || manifest.environment !== "staging" || manifest.nativeAsset !== "ETH") throw new Error("wrong Robinhood staging identity");
  if (manifest.factoryGeneration !== CURRENT_FACTORY_GENERATION || manifest.campaignGeneration !== CURRENT_CAMPAIGN_GENERATION || manifest.liquidityKind !== CURRENT_LIQUIDITY_KIND) throw new Error("wrong current generation identity");
  if (manifest.state?.factoryLive !== false || manifest.state?.createPaused !== true || manifest.state?.securityDefaultsLocked !== true) throw new Error("unsafe current staging state");
  if (manifest.state?.supportEnabled !== false || manifest.state?.creationEnabled !== false) throw new Error("current staging must remain application-dark");
  if (manifest.historicalFreezePreserved !== true) throw new Error("historical 5C freeze preservation marker missing");
  if (manifest.productionCompatible !== false || manifest.productionChainId !== 4663) throw new Error("production isolation marker invalid");
  requireAddress("manifest.treasury", manifest.treasury);
  for (const [name, address] of Object.entries(manifest.infrastructure || {})) requireAddress(`manifest.infrastructure.${name}`, address);
  for (const name of CURRENT_STAGE_REQUIRED_DEPLOYMENTS) requireAddress(`manifest.contracts.${name}`, manifest.contracts?.[name]);
  return true;
}
