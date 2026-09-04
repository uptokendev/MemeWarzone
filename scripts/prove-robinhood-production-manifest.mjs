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
  return new Set(Object.values(contracts).map((value) => normalizeAddress(value)).filter(Boolean));
}

function sha(value) {
  const raw = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(raw) ? raw : null;
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive number`);
  return number;
}

function proveStockRegistry(stock, forbidden, contracts) {
  if (!Array.isArray(stock.registry) || stock.registry.length === 0) {
    throw new Error("production Stock registry must contain at least one canonical route entry");
  }
  const seenTokens = new Set();
  const seenSymbols = new Set();
  const approvedRouter = requireAddress(contracts.v3SwapRouter, "contracts.v3SwapRouter");

  for (const [index, entry] of stock.registry.entries()) {
    const prefix = `stock.registry[${index}]`;
    const token = requireAddress(entry.contractAddress, `${prefix}.contractAddress`);
    const oracle = requireAddress(entry.oracleFeedAddress, `${prefix}.oracleFeedAddress`);
    const acquisitionPool = requireAddress(entry.acquisitionPoolAddress, `${prefix}.acquisitionPoolAddress`);
    const acquisitionQuoter = requireAddress(entry.acquisitionQuoterAddress, `${prefix}.acquisitionQuoterAddress`);
    const acquisitionRouter = requireAddress(entry.acquisitionRouterAddress, `${prefix}.acquisitionRouterAddress`);

    const symbol = String(entry.symbol || "").trim().toUpperCase();
    const underlyingSymbol = String(entry.underlyingSymbol || "").trim().toUpperCase();
    const displayName = String(entry.displayName || "").trim();
    if (!symbol) throw new Error(`${prefix}.symbol is required`);
    if (!underlyingSymbol) throw new Error(`${prefix}.underlyingSymbol is required`);
    if (!displayName) throw new Error(`${prefix}.displayName is required`);
    if (seenSymbols.has(symbol)) throw new Error(`production Stock registry duplicates symbol ${symbol}`);
    if (seenTokens.has(token)) throw new Error(`production Stock registry duplicates token ${token}`);
    seenSymbols.add(symbol);
    seenTokens.add(token);

    const decimals = Number(entry.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`${prefix}.decimals is invalid`);
    if (String(entry.oracleType || "").trim().toLowerCase() !== "chainlink") {
      throw new Error(`${prefix}.oracleType must be chainlink for production acceptance`);
    }
    if (entry.canonical !== true) throw new Error(`${prefix} must be canonical`);
    if (entry.enabledForDiscovery !== true) throw new Error(`${prefix} must be enabled for discovery`);
    if (entry.enabledForGraduation !== false || entry.enabledForTrading !== false) {
      throw new Error(`${prefix} must keep graduation/trading disabled during production preflight`);
    }

    positiveNumber(entry.minimumQuoteLiquidityUsd, `${prefix}.minimumQuoteLiquidityUsd`);
    const maxImpactBps = Number(entry.maximumGraduationSwapImpactBps);
    if (!Number.isInteger(maxImpactBps) || maxImpactBps <= 0 || maxImpactBps > 10_000) {
      throw new Error(`${prefix}.maximumGraduationSwapImpactBps is invalid`);
    }

    const feeTier = Number(entry.acquisitionFeeTier);
    if (!Number.isInteger(feeTier) || feeTier <= 0 || feeTier > 1_000_000) {
      throw new Error(`${prefix}.acquisitionFeeTier is invalid`);
    }
    if (String(entry.acquisitionQuoteKind || "").trim() !== "SIMPLE_EXACT_INPUT_SINGLE") {
      throw new Error(`${prefix}.acquisitionQuoteKind must be SIMPLE_EXACT_INPUT_SINGLE`);
    }
    if (acquisitionRouter !== approvedRouter) {
      throw new Error(`${prefix}.acquisitionRouterAddress must equal contracts.v3SwapRouter`);
    }

    for (const [label, address] of [
      ["token", token],
      ["oracle", oracle],
      ["acquisition pool", acquisitionPool],
      ["acquisition quoter", acquisitionQuoter],
      ["acquisition router", acquisitionRouter],
    ]) {
      if (forbidden?.has(address)) throw new Error(`${prefix} ${label} reuses accepted Robinhood testnet address ${address}`);
    }
  }
}

export function proveRobinhoodProductionManifest(manifest, options = {}) {
  if (!manifest || typeof manifest !== "object") throw new Error("production manifest is missing");
  const acceptedTestnet = options.acceptedTestnet || null;
  const expectedCandidateSha = sha(options.candidateSha);

  const chainId = Number(manifest.targetChainId ?? manifest.chainId);
  if (chainId !== ROBINHOOD_MAINNET_CHAIN_ID) throw new Error(`wrong Robinhood production chain: expected ${ROBINHOOD_MAINNET_CHAIN_ID}, got ${chainId}`);
  if (String(manifest.chainKey || "").toLowerCase() !== "robinhood-mainnet") throw new Error("production manifest chainKey must be robinhood-mainnet");
  if (String(manifest.environment || "").toLowerCase() !== "production") throw new Error("production manifest must declare environment=production");
  if (!Number.isInteger(Number(manifest.deploymentBlock)) || Number(manifest.deploymentBlock) <= 0) throw new Error("production deploymentBlock must be a positive integer");

  if (Number(manifest.factoryGeneration) !== EXPECTED_FACTORY_GENERATION || Number(manifest.campaignGeneration) !== EXPECTED_CAMPAIGN_GENERATION || Number(manifest.liquidityKind) !== EXPECTED_LIQUIDITY_KIND) {
    throw new Error(`wrong production generation/liquidity metadata: expected factory ${EXPECTED_FACTORY_GENERATION} / campaign ${EXPECTED_CAMPAIGN_GENERATION} / liquidity ${EXPECTED_LIQUIDITY_KIND}`);
  }

  const manifestSha = sha(manifest.sourceSha ?? manifest.candidateSha ?? manifest.buildSha);
  if (!manifestSha) throw new Error("production manifest must record a full 40-character sourceSha");
  if (expectedCandidateSha && manifestSha !== expectedCandidateSha) throw new Error(`production sourceSha mismatch: expected ${expectedCandidateSha}, got ${manifestSha}`);
  if (manifest.productionCompatible !== true) throw new Error("production manifest must explicitly declare productionCompatible=true");
  if (manifest.testnetOnly === true || manifest.stagingOnly) throw new Error("production manifest contains testnet/staging-only metadata");

  for (const flag of DARK_FLAGS) if (manifest[flag] !== false) throw new Error(`production preflight requires ${flag}=false`);
  if (manifest.factoryLive !== false || manifest.createPaused !== true) throw new Error("production preflight requires factoryLive=false and createPaused=true");
  if (manifest.securityDefaultsLocked !== true) throw new Error("production preflight requires securityDefaultsLocked=true");
  if (manifest.requireRouteAuthorization !== true || manifest.requireAuthorizedTrading !== true) throw new Error("production preflight requires route and trading authorization");

  const routeAuthority = requireAddress(manifest.routeAuthority, "routeAuthority");
  const admin = requireAddress(manifest.admin, "admin");
  if (routeAuthority === admin) throw new Error("production routeAuthority must be distinct from admin/deployer");

  const contracts = manifest.contracts || {};
  const productionAddresses = new Map();
  for (const key of REQUIRED_CONTRACTS) {
    const address = requireAddress(contracts[key], `contracts.${key}`);
    if (productionAddresses.has(address)) throw new Error(`production contracts ${productionAddresses.get(address)} and ${key} reuse ${address}`);
    productionAddresses.set(address, key);
  }

  let forbidden = null;
  if (acceptedTestnet) {
    const testnetChainId = Number(acceptedTestnet.chainId ?? acceptedTestnet.targetChainId);
    if (testnetChainId !== ROBINHOOD_TESTNET_CHAIN_ID) throw new Error("accepted testnet manifest must be chain 46630");
    forbidden = normalizedAddressSet(acceptedTestnet.contracts || {});
    for (const [address, key] of productionAddresses) if (forbidden.has(address)) throw new Error(`production contract ${key} reuses accepted Robinhood testnet address ${address}`);
  }

  const nativeUsdFeed = requireAddress(manifest.oracles?.nativeUsdFeed, "oracles.nativeUsdFeed");
  if (forbidden?.has(nativeUsdFeed)) throw new Error(`production native/USD oracle reuses accepted Robinhood testnet address ${nativeUsdFeed}`);

  const stock = manifest.stock || {};
  if (stock.canonicalRegistryConfigured !== true) throw new Error("production Stock registry must be explicitly configured before preflight can pass");
  if (stock.nativeUsdOracleConfigured !== true) throw new Error("production native/USD oracle must be explicitly configured before preflight can pass");
  if (stock.approvedAcquisitionRoutesConfigured !== true) throw new Error("production approved Stock acquisition routes must be explicitly configured before preflight can pass");
  if (stock.stockRoutesEnabled === true) throw new Error("production Stock routes must remain disabled during preflight");
  proveStockRegistry(stock, forbidden, contracts);

  if (!Array.isArray(manifest.activationPrerequisites) || manifest.activationPrerequisites.length < 4) throw new Error("production activationPrerequisites must document oracle, route, canary, and rollback gates");
  const prerequisites = manifest.activationPrerequisites.map((value) => String(value || "").trim().toLowerCase());
  for (const keyword of ["oracle", "route", "canary", "rollback"]) if (!prerequisites.some((value) => value.includes(keyword))) throw new Error(`production activationPrerequisites missing ${keyword} gate`);

  return { chainId, sourceSha: manifestSha, contractCount: productionAddresses.size, stockRouteCount: stock.registry.length, dark: true };
}

function runningAsCli() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href; }
  catch { return false; }
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
