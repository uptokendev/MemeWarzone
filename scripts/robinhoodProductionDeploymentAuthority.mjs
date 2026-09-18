#!/usr/bin/env node

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const ROBINHOOD_MAINNET_NETWORK = "robinhoodMainnet";
export const ROBINHOOD_MAINNET_GENESIS_REQUIRED = false;
export const PRODUCTION_BROADCAST_TOKEN = "DEPLOY_CHAIN_4663_CURRENT_GENERATION_DARK";
export const PRODUCTION_FACTORY_GENERATION = 4;
export const PRODUCTION_CAMPAIGN_GENERATION = 3;
export const PRODUCTION_LIQUIDITY_KIND = 2;
export const PRODUCTION_V3_FEE_TIER = 3000;
export const DEFAULT_ORACLE_MAX_AGE_SECONDS = 900;
export const DEFAULT_TREASURY_UPGRADE_DELAY_SECONDS = 3600;
export const DEFAULT_DEPLOYMENT_EVIDENCE = "deployments/robinhood/mainnet.deployment.json";
export const DEFAULT_INVENTORY = "deployments/robinhood/mainnet.inventory.json";
export const DEFAULT_CANDIDATE_MANIFEST = "deployments/robinhood/mainnet.candidate.json";
export const DEFAULT_ACCEPTED_TESTNET = "deployments/robinhood/testnet.accepted.json";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function sameAddress(a, b) {
  return Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();
}

export function requireAddress(label, value) {
  const address = String(value || "").trim();
  if (!ADDRESS_RE.test(address) || sameAddress(address, ZERO_ADDRESS) || /<|>|placeholder|changeme/i.test(address)) {
    throw new Error(`${label} must be an explicit non-zero EVM address`);
  }
  return address;
}

export function requireFullSha(value, label = "sourceSha") {
  const sha = String(value || "").trim().toLowerCase();
  if (!SHA_RE.test(sha)) throw new Error(`${label} must be a full 40-character commit SHA`);
  return sha;
}

export function requireRpcUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || /<|>|placeholder|changeme/i.test(raw)) throw new Error("ROBINHOOD_MAINNET_RPC_URL must be explicit");
  let parsed;
  try { parsed = new URL(raw); }
  catch { throw new Error("ROBINHOOD_MAINNET_RPC_URL must be an absolute HTTP(S) URL"); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("ROBINHOOD_MAINNET_RPC_URL must use HTTP(S)");
  if (/testnet|sepolia|devnet/i.test(raw)) throw new Error("Robinhood production deploy refuses testnet/devnet RPC endpoints");
  return raw;
}

export function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

export function parseStockRegistry(value) {
  let registry = value;
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) throw new Error("ROBINHOOD_STOCK_TOKEN_REGISTRY_4663 is required");
    try { registry = JSON.parse(raw); }
    catch { throw new Error("ROBINHOOD_STOCK_TOKEN_REGISTRY_4663 must be valid JSON"); }
  }
  if (!Array.isArray(registry) || registry.length === 0) {
    throw new Error("Robinhood production Stock registry must contain at least one canonical route");
  }
  const seenSymbols = new Set();
  const seenTokens = new Set();
  return registry.map((entry, index) => {
    const prefix = `stockRegistry[${index}]`;
    const symbol = String(entry?.symbol || "").trim().toUpperCase();
    const displayName = String(entry?.displayName || "").trim();
    const underlyingSymbol = String(entry?.underlyingSymbol || "").trim().toUpperCase();
    if (!symbol || !displayName || !underlyingSymbol) throw new Error(`${prefix} identity is incomplete`);
    if (seenSymbols.has(symbol)) throw new Error(`duplicate Stock symbol ${symbol}`);
    seenSymbols.add(symbol);

    const contractAddress = requireAddress(`${prefix}.contractAddress`, entry.contractAddress);
    const tokenKey = contractAddress.toLowerCase();
    if (seenTokens.has(tokenKey)) throw new Error(`duplicate Stock token ${contractAddress}`);
    seenTokens.add(tokenKey);

    const decimals = Number(entry.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`${prefix}.decimals is invalid`);
    if (String(entry.oracleType || "").trim().toLowerCase() !== "chainlink") throw new Error(`${prefix}.oracleType must be chainlink`);
    if (entry.canonical !== true || entry.enabledForDiscovery !== true) throw new Error(`${prefix} must be canonical and discovery-enabled`);
    if (entry.enabledForGraduation !== false || entry.enabledForTrading !== false) {
      throw new Error(`${prefix} must keep public graduation/trading dark in production preflight`);
    }
    const minimumQuoteLiquidityUsd = Number(entry.minimumQuoteLiquidityUsd);
    if (!Number.isFinite(minimumQuoteLiquidityUsd) || minimumQuoteLiquidityUsd <= 0) throw new Error(`${prefix}.minimumQuoteLiquidityUsd is invalid`);
    const maximumGraduationSwapImpactBps = positiveInteger(entry.maximumGraduationSwapImpactBps, `${prefix}.maximumGraduationSwapImpactBps`);
    if (maximumGraduationSwapImpactBps > 10_000) throw new Error(`${prefix}.maximumGraduationSwapImpactBps exceeds 10000`);
    const acquisitionFeeTier = positiveInteger(entry.acquisitionFeeTier, `${prefix}.acquisitionFeeTier`);
    if (String(entry.acquisitionQuoteKind || "").trim() !== "SIMPLE_EXACT_INPUT_SINGLE") {
      throw new Error(`${prefix}.acquisitionQuoteKind must be SIMPLE_EXACT_INPUT_SINGLE`);
    }

    return {
      ...entry,
      symbol,
      displayName,
      underlyingSymbol,
      decimals,
      contractAddress,
      oracleFeedAddress: requireAddress(`${prefix}.oracleFeedAddress`, entry.oracleFeedAddress),
      acquisitionPoolAddress: requireAddress(`${prefix}.acquisitionPoolAddress`, entry.acquisitionPoolAddress),
      acquisitionQuoterAddress: requireAddress(`${prefix}.acquisitionQuoterAddress`, entry.acquisitionQuoterAddress),
      acquisitionRouterAddress: requireAddress(`${prefix}.acquisitionRouterAddress`, entry.acquisitionRouterAddress),
      oracleType: "chainlink",
      canonical: true,
      enabledForDiscovery: true,
      enabledForGraduation: false,
      enabledForTrading: false,
      minimumQuoteLiquidityUsd,
      maximumGraduationSwapImpactBps,
      acquisitionFeeTier,
      acquisitionQuoteKind: "SIMPLE_EXACT_INPUT_SINGLE",
    };
  });
}

export function parseGraduationPolicy(env = process.env) {
  const policy = {
    maxOracleAgeSeconds: positiveInteger(
      env.ROBINHOOD_STOCK_GRADUATION_MAX_ORACLE_AGE_SECONDS || env.ROBINHOOD_NATIVE_USD_MAX_ORACLE_AGE_SECONDS || DEFAULT_ORACLE_MAX_AGE_SECONDS,
      "maxOracleAgeSeconds",
    ),
    maxSwapSlippageBps: positiveInteger(env.ROBINHOOD_STOCK_GRADUATION_MAX_SWAP_SLIPPAGE_BPS || 300, "maxSwapSlippageBps"),
    maxOracleDeviationBps: positiveInteger(env.ROBINHOOD_STOCK_GRADUATION_MAX_ORACLE_DEVIATION_BPS || 300, "maxOracleDeviationBps"),
    maxPriceImpactBps: positiveInteger(env.ROBINHOOD_STOCK_GRADUATION_MAX_PRICE_IMPACT_BPS || 500, "maxPriceImpactBps"),
    minimumRouteLiquidityUsd: positiveInteger(env.ROBINHOOD_STOCK_GRADUATION_MIN_ROUTE_LIQUIDITY_USD || 25000, "minimumRouteLiquidityUsd"),
  };
  for (const key of ["maxSwapSlippageBps","maxOracleDeviationBps","maxPriceImpactBps"]) {
    if (policy[key] > 10_000) throw new Error(`${key} exceeds 10000`);
  }
  return policy;
}

export function acceptedTestnetAddressSet(manifest) {
  if (!manifest || Number(manifest.chainId) !== 46630) throw new Error("accepted Robinhood testnet manifest must be chain 46630");
  const out = new Set();
  for (const value of [manifest.factory, manifest.admin, manifest.routeAuthority, ...Object.values(manifest.contracts || {})]) {
    if (ADDRESS_RE.test(String(value || ""))) out.add(String(value).toLowerCase());
  }
  return out;
}

export function assertNoAcceptedTestnetReuse(addresses, acceptedTestnet) {
  const forbidden = acceptedTestnetAddressSet(acceptedTestnet);
  for (const [label, raw] of Object.entries(addresses || {})) {
    const value = requireAddress(label, raw);
    if (forbidden.has(value.toLowerCase())) throw new Error(`${label} reuses accepted Robinhood testnet address ${value}`);
  }
  return true;
}

export function validateProductionDeploymentBoundary(input) {
  const chainId = Number(input.chainId);
  if (chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
    throw new Error(`Robinhood production deploy requires chain ${ROBINHOOD_MAINNET_CHAIN_ID}; got ${chainId}`);
  }
  if (String(input.networkName || "") !== ROBINHOOD_MAINNET_NETWORK) {
    throw new Error(`Robinhood production deploy requires Hardhat network ${ROBINHOOD_MAINNET_NETWORK}`);
  }
  const rpcUrl = requireRpcUrl(input.rpcUrl);
  const sourceSha = requireFullSha(input.sourceSha);
  const deployer = requireAddress("deployer", input.deployer);
  const admin = requireAddress("ROBINHOOD_MAINNET_ADMIN", input.admin);
  const routeAuthority = requireAddress("ROBINHOOD_ROUTE_AUTHORITY_ADDRESS_4663", input.routeAuthority);
  if (!sameAddress(deployer, admin)) throw new Error("Robinhood production deployer must exactly equal ROBINHOOD_MAINNET_ADMIN");
  if (sameAddress(admin, routeAuthority)) throw new Error("Robinhood production route authority must be distinct from admin/deployer");

  const infrastructure = {
    v3Factory: requireAddress("ROBINHOOD_V3_FACTORY_ADDRESS_4663", input.v3Factory),
    positionManager: requireAddress("ROBINHOOD_V3_POSITION_MANAGER_ADDRESS_4663", input.positionManager),
    swapRouter: requireAddress("ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_4663", input.swapRouter),
    weth: requireAddress("WRAPPED_NATIVE_ADDRESS_4663", input.weth),
    nativeUsdOracle: requireAddress("ROBINHOOD_NATIVE_USD_ORACLE_ADDRESS_4663", input.nativeUsdOracle),
  };
  assertNoAcceptedTestnetReuse({ admin, routeAuthority, ...infrastructure }, input.acceptedTestnet);

  const policy = parseGraduationPolicy(input.env || process.env);
  const registry = parseStockRegistry(input.stockRegistry);
  for (const route of registry) {
    if (!sameAddress(route.acquisitionRouterAddress, infrastructure.swapRouter)) {
      throw new Error(`${route.symbol} acquisitionRouterAddress must equal ROBINHOOD_V3_SWAP_ROUTER_ADDRESS_4663`);
    }
    if (route.minimumQuoteLiquidityUsd < policy.minimumRouteLiquidityUsd) {
      throw new Error(`${route.symbol} minimumQuoteLiquidityUsd is below production policy minimum`);
    }
    if (route.maximumGraduationSwapImpactBps > policy.maxPriceImpactBps) {
      throw new Error(`${route.symbol} maximumGraduationSwapImpactBps exceeds production policy`);
    }
    assertNoAcceptedTestnetReuse({
      [`${route.symbol}.contractAddress`]: route.contractAddress,
      [`${route.symbol}.oracleFeedAddress`]: route.oracleFeedAddress,
      [`${route.symbol}.acquisitionPoolAddress`]: route.acquisitionPoolAddress,
      [`${route.symbol}.acquisitionQuoterAddress`]: route.acquisitionQuoterAddress,
      [`${route.symbol}.acquisitionRouterAddress`]: route.acquisitionRouterAddress,
    }, input.acceptedTestnet);
  }

  return {
    chainId,
    networkName: ROBINHOOD_MAINNET_NETWORK,
    rpcUrl,
    sourceSha,
    deployer,
    admin,
    routeAuthority,
    infrastructure,
    policy,
    registry,
    broadcast: String(input.broadcastToken || "").trim() === PRODUCTION_BROADCAST_TOKEN,
  };
}
