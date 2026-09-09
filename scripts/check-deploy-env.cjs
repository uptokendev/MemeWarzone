#!/usr/bin/env node
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");

const TARGET = process.argv[2] || process.env.HARDHAT_NETWORK || "hardhat";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const PRIVATE_KEY_RE = /^(0x)?[a-fA-F0-9]{64}$/;

const IS_BSC_TESTNET = TARGET === "bscTestnet";
const IS_BSC_MAINNET = TARGET === "bscMainnet";
const IS_REAL_BSC_NETWORK = IS_BSC_TESTNET || IS_BSC_MAINNET;
const BSC_RPC_ENVS = IS_BSC_MAINNET
  ? ["BSC_MAINNET_RPC", "BSC_MAINNET_RPC_URL"]
  : ["BSC_TESTNET_RPC", "BSC_TESTNET_RPC_URL"];
const DEPLOYER_PRIVATE_KEY_ENVS = ["DEPLOYER_PK", "PRIVATE_KEY_DEPLOY"];
const TOPAZ_ROUTER_ENVS = ["TOPAZ_ROUTER", "TOPAZ_V2_ROUTER", "ROUTER_ADDRESS"];
const LEGACY_ROUTER_ENVS = ["PANCAKE_ROUTER", "PANCAKE_V2_ROUTER"];
const ROUTER_ENVS = [...TOPAZ_ROUTER_ENVS, ...LEGACY_ROUTER_ENVS];
const PRICE_ENVS = ["GRADUATION_ORACLE_ADDRESS", "BNB_USD_PRICE_FEED", "NATIVE_USD_PRICE_FEED", "GRADUATION_PRICE_FEED"];
const TREASURY_ROUTER_V2_FLAG_ENVS = ["DEPLOY_TREASURY_ROUTER_V2", "USE_TREASURY_ROUTER_V2"];
const MONTHLY_LEAGUE_TREASURY_ENVS = ["MONTHLY_LEAGUE_TREASURY", "MONTHLY_LEAGUE_TREASURY_ADDRESS"];
const CHARITY_TREASURY_ENVS = ["CHARITY_TREASURY", "CHARITY_TREASURY_ADDRESS"];
const REAL_NETWORK_ADMIN_ENVS = [
  "TREASURY_SAFE",
  "ROUTE_AUTHORITY_ADDRESS",
  "LEAGUE_PAYOUT_OPERATOR",
  "LEAGUE_ROOT_POSTER",
  "RECRUITER_PAYOUT_OPERATOR",
];
const MOCK_FLAG_ENVS = ["DEPLOY_MOCK_TOPAZ_ROUTER", "DEPLOY_MOCK_ROUTER", "DEPLOY_MOCK_PRICE_FEED"];
const KNOWN_LOCAL_ADDRESSES = new Set([
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6e51aad88f6f4ce6ab8827279cfffb906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
]);
const KNOWN_LOCAL_PRIVATE_KEYS = new Set([
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "59c6995e998f97a5a0044966f0945389d8f4e2145e3ea535c9ea6d1cfef39d4",
  "5de4111a2f57843d4a54c1c7d2254141e70cdb4c5b4bc7d22477d90b4f0ad7a3",
]);

const errors = [];
const warnings = [];

function raw(name) {
  return (process.env[name] || "").trim();
}

function hasAny(names) {
  return names.some((name) => raw(name));
}

function normalizePrivateKey(value) {
  return value.toLowerCase().replace(/^0x/, "");
}

function checkAddress(name, required = false) {
  const value = raw(name);
  if (!value) {
    if (required) errors.push(`${name}: missing address`);
    return;
  }
  if (!ADDRESS_RE.test(value)) errors.push(`${name}: expected 20-byte 0x address`);
}

function checkPrivateKey(name, required = false) {
  const value = raw(name);
  if (!value) {
    if (required) errors.push(`${name}: missing private key`);
    return;
  }
  if (!PRIVATE_KEY_RE.test(value)) errors.push(`${name}: expected 32-byte hex private key`);
}

function checkRequiredAny(names, message) {
  if (!hasAny(names)) errors.push(`${names[0]}: ${message}`);
}

function checkNotLocalAddress(name) {
  const value = raw(name);
  if (!value || !ADDRESS_RE.test(value)) return;
  if (KNOWN_LOCAL_ADDRESSES.has(value.toLowerCase())) {
    errors.push(`${name}: uses a default Hardhat local account; set a real testnet-controlled address`);
  }
}

function checkNotLocalPrivateKey(name) {
  const value = raw(name);
  if (!value || !PRIVATE_KEY_RE.test(value)) return;
  if (KNOWN_LOCAL_PRIVATE_KEYS.has(normalizePrivateKey(value))) {
    errors.push(`${name}: uses a default Hardhat local private key; set a real funded testnet deployer key`);
  }
}

function boolValue(name) {
  const value = raw(name).toLowerCase();
  if (!value) return null;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

function isTruthyEnv(name) {
  return boolValue(name) === true;
}

function checkBool(name) {
  const value = raw(name).toLowerCase();
  if (!value) return;
  if (!["1", "0", "true", "false", "yes", "no", "on", "off"].includes(value)) {
    errors.push(`${name}: expected boolean value`);
  }
}

function checkRouteProfile(name) {
  const value = raw(name);
  if (!value) return;
  if (!["0", "1", "2"].includes(value)) errors.push(`${name}: expected 0, 1, or 2`);
}

function checkBigInt(name) {
  const value = raw(name);
  if (!value) return;
  try {
    if (BigInt(value) < 0n) errors.push(`${name}: expected non-negative integer`);
  } catch {
    errors.push(`${name}: expected integer`);
  }
}

function firstConfigured(names) {
  return names.find((name) => raw(name));
}

function useTreasuryRouterV2() {
  const primary = boolValue("DEPLOY_TREASURY_ROUTER_V2");
  return primary ?? boolValue("USE_TREASURY_ROUTER_V2") ?? false;
}

function checkTreasuryRouterV2Env() {
  TREASURY_ROUTER_V2_FLAG_ENVS.forEach(checkBool);
  MONTHLY_LEAGUE_TREASURY_ENVS.forEach((name) => checkAddress(name));
  CHARITY_TREASURY_ENVS.forEach((name) => checkAddress(name));

  const deployFlag = boolValue("DEPLOY_TREASURY_ROUTER_V2");
  const useFlag = boolValue("USE_TREASURY_ROUTER_V2");
  if (deployFlag !== null && useFlag !== null && deployFlag !== useFlag) {
    errors.push("DEPLOY_TREASURY_ROUTER_V2 and USE_TREASURY_ROUTER_V2 disagree; set only one or make them match");
  }

  if (useTreasuryRouterV2() && !hasAny(MONTHLY_LEAGUE_TREASURY_ENVS)) {
    warnings.push("TreasuryRouterV2 enabled without MONTHLY_LEAGUE_TREASURY; deployProtocol will deploy MonthlyLeagueTreasury.");
  }
  if (useTreasuryRouterV2() && !hasAny(CHARITY_TREASURY_ENVS)) {
    warnings.push("TreasuryRouterV2 enabled without CHARITY_TREASURY; deployProtocol will deploy CharityTreasury for monthly overflow.");
  }
}

function defaultTopazManifestPath() {
  return path.join(process.cwd(), "deployments", TARGET, "minimal-topaz.json");
}

function configuredTopazManifestPath() {
  return raw("TOPAZ_MANIFEST") || (fs.existsSync(defaultTopazManifestPath()) ? defaultTopazManifestPath() : "");
}

function requireManifestAddress(manifest, key, manifestPath) {
  const value = manifest.contracts && manifest.contracts[key];
  if (!ADDRESS_RE.test(value || "")) errors.push(`TOPAZ_MANIFEST: contracts.${key} must be a 20-byte 0x address in ${manifestPath}`);
}

function checkTopazManifest(required = false) {
  const manifestPath = configuredTopazManifestPath();
  if (!manifestPath) {
    if (required) errors.push("TOPAZ_MANIFEST: missing Minimal Topaz manifest or deployments/<network>/minimal-topaz.json");
    return false;
  }

  const resolved = path.resolve(manifestPath);
  if (!fs.existsSync(resolved)) {
    errors.push(`TOPAZ_MANIFEST: file not found at ${resolved}`);
    return false;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(resolved, "utf8"));
    requireManifestAddress(manifest, "Router", resolved);
    requireManifestAddress(manifest, "PoolFactory", resolved);
    requireManifestAddress(manifest, "WBNB", resolved);
    if (IS_BSC_MAINNET) {
      for (const key of ["Router", "PoolFactory", "WBNB"]) {
        const value = String(manifest.contracts?.[key] || "").toLowerCase();
        if (value === "0x0000000000000000000000000000000000000000") {
          errors.push(`TOPAZ_MANIFEST: contracts.${key} is still the unsigned placeholder`);
        }
      }
    }

    const chainId = Number(manifest.chainId || 0);
    const fee = Number(manifest.configuration && manifest.configuration.volatileFeeBps);
    const graduationPoolStable = manifest.configuration && manifest.configuration.graduationPoolStable;
    const expectedChainId = IS_BSC_MAINNET ? 56 : IS_BSC_TESTNET ? 97 : null;
    const expectedVolatileFeeBps = IS_BSC_TESTNET ? 30 : 100;
    if (expectedChainId && chainId !== expectedChainId) {
      errors.push(`TOPAZ_MANIFEST: chainId must be ${expectedChainId} for ${TARGET}, got ${chainId}`);
    }
    if (fee !== expectedVolatileFeeBps) {
      errors.push(`TOPAZ_MANIFEST: configuration.volatileFeeBps must be ${expectedVolatileFeeBps}, got ${fee}`);
    }
    if (graduationPoolStable !== false) errors.push(`TOPAZ_MANIFEST: configuration.graduationPoolStable must be false, got ${graduationPoolStable}`);
    return true;
  } catch (error) {
    errors.push(`TOPAZ_MANIFEST: could not parse ${resolved}: ${error.message}`);
    return false;
  }
}

function checkLegacyRouterAliases(isRealNetwork) {
  if (!hasAny(LEGACY_ROUTER_ENVS)) return;
  if (hasAny(TOPAZ_ROUTER_ENVS)) {
    warnings.push("Legacy PANCAKE_ROUTER/PANCAKE_V2_ROUTER aliases are set but ignored in favor of Topaz router envs.");
    return;
  }
  const message = "Legacy PANCAKE_ROUTER/PANCAKE_V2_ROUTER aliases are not accepted for Topaz rollout; set TOPAZ_ROUTER, TOPAZ_V2_ROUTER, ROUTER_ADDRESS, or TOPAZ_MANIFEST.";
  if (isRealNetwork) errors.push(message);
  else warnings.push(message);
}

function checkCommon(options = {}) {
  const requireTreasurySafe = options.requireTreasurySafe || false;
  const warnMissingRouteAuthority = options.warnMissingRouteAuthority !== false;

  checkAddress("TREASURY_SAFE", requireTreasurySafe);
  checkAddress("ROUTE_AUTHORITY_ADDRESS");
  checkPrivateKey("ROUTE_AUTHORITY_PRIVATE_KEY");
  checkRouteProfile("PHASE1_TRADE_ROUTE_PROFILE");
  checkRouteProfile("PHASE1_FINALIZE_ROUTE_PROFILE");
  checkTreasuryRouterV2Env();

  checkAddress("LEAGUE_PAYOUT_OPERATOR");
  checkAddress("LEAGUE_ROOT_POSTER");
  checkAddress("RECRUITER_PAYOUT_OPERATOR");

  [
    "GRADUATION_ORACLE_MAX_PRICE_AGE_SECONDS",
    "MONTHLY_LEAGUE_CAP_USD",
    "LEAGUE_PAYOUT_MAX_PER_TX",
    "LEAGUE_PAYOUT_DAILY_CAP",
    "LEAGUE_CLAIM_MAX_PER_TX",
    "LEAGUE_CLAIM_MAX_EPOCH_TOTAL",
    "RECRUITER_PAYOUT_MAX_PER_TX",
    "RECRUITER_PAYOUT_DAILY_CAP",
  ].forEach(checkBigInt);

  [
    "ENABLE_LEAGUE_PAYOUTS",
    "ENABLE_LEAGUE_CLAIMS",
    "ENABLE_RECRUITER_PAYOUTS",
    ...MOCK_FLAG_ENVS,
    ...TREASURY_ROUTER_V2_FLAG_ENVS,
  ].forEach(checkBool);

  if (warnMissingRouteAuthority && !raw("ROUTE_AUTHORITY_ADDRESS") && !raw("ROUTE_AUTHORITY_PRIVATE_KEY")) {
    warnings.push("ROUTE_AUTHORITY_ADDRESS is not set; route-authorized launches/trades will be unavailable until set on-chain.");
  }
}

function checkLocal() {
  checkCommon();
  checkLegacyRouterAliases(false);
  checkTopazManifest(false);
  if (!raw("TREASURY_SAFE")) warnings.push("TREASURY_SAFE is unset; local deploy will fall back to the deployer address.");
  if (!hasAny(ROUTER_ENVS) && !configuredTopazManifestPath()) warnings.push("No Topaz router or manifest configured; local deploy will use a mock router.");
  if (!hasAny(PRICE_ENVS)) warnings.push("No graduation oracle/price feed configured; local deploy will use a mock price feed.");
}

function checkBscNetwork() {
  const expectedChainId = IS_BSC_MAINNET ? 56 : 97;
  const networkLabel = IS_BSC_MAINNET ? "mainnet" : "testnet";
  checkRequiredAny(BSC_RPC_ENVS, `required for --network ${TARGET}`);
  if (!hasAny(DEPLOYER_PRIVATE_KEY_ENVS)) errors.push("DEPLOYER_PK: missing private key");
  for (const name of DEPLOYER_PRIVATE_KEY_ENVS) checkPrivateKey(name);
  checkCommon({ requireTreasurySafe: true, warnMissingRouteAuthority: false });
  for (const name of DEPLOYER_PRIVATE_KEY_ENVS) checkNotLocalPrivateKey(name);
  checkNotLocalPrivateKey("ROUTE_AUTHORITY_PRIVATE_KEY");
  REAL_NETWORK_ADMIN_ENVS.forEach(checkNotLocalAddress);

  if (!raw("ETHERSCAN_API_KEY") && !IS_BSC_MAINNET) {
    warnings.push("ETHERSCAN_API_KEY is unset; deployment can run, but Etherscan V2 contract verification will fail.");
  }

  const hasRouterEnv = hasAny(TOPAZ_ROUTER_ENVS);
  const hasManifest = checkTopazManifest(false);
  if (!hasRouterEnv && !hasManifest) {
    errors.push(`Topaz router missing: set one of ${TOPAZ_ROUTER_ENVS.join(", ")} or TOPAZ_MANIFEST`);
  }
  checkLegacyRouterAliases(true);
  if (!hasAny(PRICE_ENVS)) {
    errors.push(`Graduation oracle/price feed missing: set one of ${PRICE_ENVS.join(", ")}`);
  }

  for (const name of ROUTER_ENVS) checkAddress(name);
  for (const name of PRICE_ENVS) checkAddress(name);

  if (!raw("ROUTE_AUTHORITY_ADDRESS") && !raw("ROUTE_AUTHORITY_PRIVATE_KEY")) {
    errors.push(`ROUTE_AUTHORITY_ADDRESS or ROUTE_AUTHORITY_PRIVATE_KEY is required for ${networkLabel} rollout`);
  }

  for (const name of MOCK_FLAG_ENVS) {
    if (isTruthyEnv(name)) errors.push(`${name}: mocks are only allowed for local hardhat rehearsal`);
  }

  if (IS_BSC_MAINNET) {
    const rpcName = firstConfigured(BSC_RPC_ENVS);
    const rpcValue = rpcName ? raw(rpcName).toLowerCase() : "";
    if (/(?:testnet|prebsc|chapel)/.test(rpcValue)) {
      errors.push(`${rpcName}: mainnet deployment RPC looks like a BSC testnet endpoint`);
    }
    const graduationTarget = raw("GRADUATION_TARGET_USD");
    if (!/^\d+(?:\.\d+)?$/.test(graduationTarget)) {
      errors.push("GRADUATION_TARGET_USD: explicit positive USD target is required for mainnet");
    } else if (Number(graduationTarget) < 15000) {
      errors.push("GRADUATION_TARGET_USD: mainnet target must be at least 15000 USD");
    }
    if (!useTreasuryRouterV2()) {
      errors.push("DEPLOY_TREASURY_ROUTER_V2: mainnet requires TreasuryRouterV2");
    }
    if (!raw("ETHERSCAN_API_KEY")) {
      errors.push("ETHERSCAN_API_KEY: required for mainnet source verification");
    }
  }

  if (!Number.isInteger(expectedChainId)) errors.push(`Unsupported BSC target ${TARGET}`);
}

if (IS_REAL_BSC_NETWORK) checkBscNetwork();
else checkLocal();

console.log(`[deploy-env] target=${TARGET}`);
console.log(`[deploy-env] rpc=${firstConfigured(BSC_RPC_ENVS) || "unset"}`);
console.log(`[deploy-env] deployerKey=${firstConfigured(DEPLOYER_PRIVATE_KEY_ENVS) || "unset"}`);
console.log(`[deploy-env] router=${firstConfigured(ROUTER_ENVS) || (configuredTopazManifestPath() ? "TOPAZ_MANIFEST" : "unset")}`);
console.log(`[deploy-env] graduation=${firstConfigured(PRICE_ENVS) || "unset"}`);
console.log(`[deploy-env] treasurySafe=${raw("TREASURY_SAFE") || "fallback/deployer"}`);
console.log(`[deploy-env] treasuryRouter=${useTreasuryRouterV2() ? "TreasuryRouterV2" : "TreasuryRouter"}`);
console.log(`[deploy-env] monthlyLeagueTreasury=${firstConfigured(MONTHLY_LEAGUE_TREASURY_ENVS) || (useTreasuryRouterV2() ? "auto-deploy" : "n/a")}`);
console.log(`[deploy-env] charityTreasury=${firstConfigured(CHARITY_TREASURY_ENVS) || (useTreasuryRouterV2() ? "auto-deploy" : "n/a")}`);
console.log(`[deploy-env] routeAuthority=${raw("ROUTE_AUTHORITY_ADDRESS") || (raw("ROUTE_AUTHORITY_PRIVATE_KEY") ? "private-key-derived" : "unset")}`);

for (const warning of warnings) console.warn(`[deploy-env] warning: ${warning}`);

if (errors.length) {
  for (const error of errors) console.error(`[deploy-env] error: ${error}`);
  process.exitCode = 1;
} else {
  console.log("[deploy-env] OK");
}
