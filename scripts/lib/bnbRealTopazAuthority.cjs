const fs = require("node:fs");
const path = require("node:path");

const BNB_TESTNET_CHAIN_ID = 97;
const REQUIRED_VOLATILE_FEE_BPS = 30;
const TOPAZ_DEPLOYMENT_AUTHORITY = "0507a2debf438c9d3b2e387c880c96394ffade9d";
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const TOPAZ_KEYS = ["Router", "PoolFactory", "FactoryRegistry", "WBNB", "PoolImplementation"];

function sameAddress(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function requireAddress(value, label) {
  if (!ADDRESS_RE.test(String(value || "")) || /^0x0{40}$/i.test(String(value || ""))) {
    throw new Error(`${label} must be a non-zero 20-byte address`);
  }
  return value;
}

function defaultManifestPath(root = process.cwd()) {
  return path.join(root, "deployments", "bscTestnet", "minimal-topaz.json");
}

function loadAuthoritativeTopazManifest(file = defaultManifestPath()) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) throw new Error(`authoritative Topaz manifest missing: ${resolved}`);
  const manifest = JSON.parse(fs.readFileSync(resolved, "utf8"));
  validateAuthoritativeTopazManifest(manifest);
  return { file: resolved, manifest };
}

function validateAuthoritativeTopazManifest(manifest) {
  if (manifest?.network !== "bscTestnet") throw new Error(`Topaz manifest network must be bscTestnet, got ${manifest?.network}`);
  if (Number(manifest?.chainId) !== BNB_TESTNET_CHAIN_ID) throw new Error(`Topaz manifest chainId must be 97, got ${manifest?.chainId}`);
  if (String(manifest?.deploymentCommit || "") !== TOPAZ_DEPLOYMENT_AUTHORITY) {
    throw new Error(`Topaz deployment authority must be ${TOPAZ_DEPLOYMENT_AUTHORITY}`);
  }
  if (Number(manifest?.configuration?.volatileFeeBps) !== REQUIRED_VOLATILE_FEE_BPS) {
    throw new Error(`Topaz volatile fee must be exactly 30 bps, got ${manifest?.configuration?.volatileFeeBps}`);
  }
  if (manifest?.configuration?.graduationPoolStable !== false) throw new Error("Topaz graduation pool must be volatile (stable=false)");
  for (const key of TOPAZ_KEYS) requireAddress(manifest?.contracts?.[key], `Topaz manifest contracts.${key}`);
  return manifest;
}

function assertRuntimeTopazIdentity(runtime, manifest) {
  validateAuthoritativeTopazManifest(manifest);
  if (Number(runtime?.chainId) !== BNB_TESTNET_CHAIN_ID) throw new Error(`real Topaz executor refuses chain ${runtime?.chainId}`);
  const checks = [
    ["Router", runtime?.router, manifest.contracts.Router],
    ["PoolFactory", runtime?.poolFactory, manifest.contracts.PoolFactory],
    ["FactoryRegistry", runtime?.factoryRegistry, manifest.contracts.FactoryRegistry],
    ["WBNB", runtime?.wbnb, manifest.contracts.WBNB],
    ["PoolImplementation", runtime?.poolImplementation, manifest.contracts.PoolImplementation],
  ];
  for (const [label, actual, expected] of checks) {
    if (!sameAddress(actual, expected)) throw new Error(`runtime ${label} mismatch: expected ${expected}, got ${actual}`);
  }
  if (Number(runtime?.volatileFeeBps) !== REQUIRED_VOLATILE_FEE_BPS) {
    throw new Error(`runtime volatile fee must be exactly 30 bps, got ${runtime?.volatileFeeBps}`);
  }
  return true;
}

function assertRealStageManifest(stage, topazManifest) {
  validateAuthoritativeTopazManifest(topazManifest);
  if (Number(stage?.chainId) !== 97 || Number(stage?.targetChainId) !== 97) throw new Error("real Topaz stage must target chain 97");
  if (Number(stage?.factoryGeneration) !== 4 || Number(stage?.campaignGeneration) !== 3 || Number(stage?.liquidityKind) !== 1) {
    throw new Error("real Topaz stage must preserve Factory 4 / Campaign 3 / liquidityKind 1");
  }
  if (stage?.stagingOnly?.controlledTopazDex !== false) throw new Error("real Topaz executor forbids controlledTopazDex=true");
  if (stage?.stagingOnly?.realTopazCompatibility !== true) throw new Error("real Topaz stage must declare realTopazCompatibility=true");
  const contractKeys = Object.keys(stage?.contracts || {});
  if (contractKeys.some((key) => /mocktopaz/i.test(key))) throw new Error("real Topaz stage forbids MockTopaz contract keys");
  const c = stage?.contracts || {};
  for (const [stageKey, manifestKey] of [
    ["realTopazRouter", "Router"],
    ["realTopazFactory", "PoolFactory"],
    ["realTopazFactoryRegistry", "FactoryRegistry"],
    ["realWbnb", "WBNB"],
    ["realTopazPoolImplementation", "PoolImplementation"],
  ]) {
    if (!sameAddress(c[stageKey], topazManifest.contracts[manifestKey])) {
      throw new Error(`${stageKey} does not match authoritative Topaz manifest`);
    }
  }
  return true;
}

function assertGraduatedPoolIdentity(pool, tokenAddress, topazManifest) {
  validateAuthoritativeTopazManifest(topazManifest);
  if (pool?.stable !== false) throw new Error("graduated Topaz pool must have stable=false");
  if (!sameAddress(pool?.factory, topazManifest.contracts.PoolFactory)) throw new Error("graduated pool factory is not authoritative PoolFactory");
  const pairOk =
    (sameAddress(pool?.token0, tokenAddress) && sameAddress(pool?.token1, topazManifest.contracts.WBNB)) ||
    (sameAddress(pool?.token1, tokenAddress) && sameAddress(pool?.token0, topazManifest.contracts.WBNB));
  if (!pairOk) throw new Error("graduated pool pair is not exact MEME/WBNB");
  if (Number(pool?.volatileFeeBps) !== REQUIRED_VOLATILE_FEE_BPS) throw new Error("graduated pool fee is not exactly 30 bps");
  return true;
}

module.exports = {
  BNB_TESTNET_CHAIN_ID,
  REQUIRED_VOLATILE_FEE_BPS,
  TOPAZ_DEPLOYMENT_AUTHORITY,
  TOPAZ_KEYS,
  sameAddress,
  defaultManifestPath,
  loadAuthoritativeTopazManifest,
  validateAuthoritativeTopazManifest,
  assertRuntimeTopazIdentity,
  assertRealStageManifest,
  assertGraduatedPoolIdentity,
};
