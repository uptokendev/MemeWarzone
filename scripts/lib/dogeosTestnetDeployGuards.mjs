// DogeOS Chikyū testnet (6281971): the broadcast guards and pure helpers behind scripts/deploy-dogeos-testnet.ts,
// scripts/verify-dogeos-testnet.ts and scripts/activate-dogeos-testnet.ts, which deploy, verify and open the Bark
// stack (gen-8 on Barkswap custom pools; barkswap plan t15, spec section 3 "Roles and keys (B9)", section 5
// "Deployment 1"). First written for the gen-7 stack (foundation t8); its gen-7 factory and V3 venue parts are gone (B8).
//
// Pure functions only (no provider, no hardhat, no key), so every refusal path is tested without a network by
// scripts/dogeos-testnet-deploy-guards.test.mjs. The TypeScript entrypoints and scripts/lib/dogeosBarkStack.ts do the
// chain reads and the sends and pass plain values in here. Broadcast-token pattern:
// scripts/robinhoodTestnetInfrastructureAuthority.mjs.
//
// Two modes:
//   "chikyu"       network dogeosTestnet, chain 6281971. Strict: the signer must be the DogeOS deployer 0x6c5C…82f8 and
//                  the route authority (the launcher's createSigner) the pinned DogeOS route authority 0x4fcD…76FF.
//   "chikyu-fork"  the in-process hardhat network forking Chikyū (hardhat.dogeos-bark-fork.config.ts, chain 6281971),
//                  which cannot broadcast to Chikyū. The fork's own first signer is the deployer (admin), and the route
//                  authority is any valid address that collides with none of the DogeOS keys or the signer.
// Both modes need the broadcast token (deploy: DOGEOS_TESTNET_DEPLOY_BROADCAST, activate: DOGEOS_TESTNET_ACTIVATE_BROADCAST).
//
// Keys: nothing here reads a key or config/*.local. The route authority (DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS) and the
// DogeOS operator (DOGEOS_OPERATOR_ADDRESS, spec B9: splitter `route`, router `claimRouter`, choice-vault `buyback` /
// `executeHolderBatch`) are public address parameters, never derived from a key. The operator's address is unknown
// until the founder generates the key (plan t29), so it is never pinned here; it must differ from every other key.
import fs from "node:fs";
import path from "node:path";
import { getAddress } from "ethers";

export const DOGEOS_TESTNET_CHAIN_ID = 6281971;
export const DOGEOS_TESTNET_NETWORK_NAME = "dogeosTestnet";
export const DOGEOS_DEPLOY_BROADCAST_ENV = "DOGEOS_TESTNET_DEPLOY_BROADCAST";
export const DOGEOS_ACTIVATE_BROADCAST_ENV = "DOGEOS_TESTNET_ACTIVATE_BROADCAST";
export const DOGEOS_DEPLOY_BROADCAST_TOKEN = "I_HAVE_FOUNDER_GO";
export const DOGEOS_ROUTE_AUTHORITY_ENV = "DOGEOS_TESTNET_ROUTE_AUTHORITY_ADDRESS";
export const DOGEOS_OPERATOR_ENV = "DOGEOS_OPERATOR_ADDRESS";
/** The DogeOS route authority (spec B9: the launcher's createSigner): the only one accepted on Chikyū itself. */
export const DOGEOS_TESTNET_ROUTE_AUTHORITY = "0x4fcD24d620f8eCd298bF4d43CB1cA2F4D23876FF";
/** Fork-only: where a fork deploy writes / a fork activate reads its manifest. Refused on Chikyū itself. */
export const DOGEOS_MANIFEST_OVERRIDE_ENV = "DOGEOS_TESTNET_MANIFEST";
export const DOGEOS_MANIFEST_PATH = "deployments/dogeos/testnet.bark.json";
export const DOGEOS_VERIFICATION_PATH = "config/verification/dogeos-testnet-contracts.json";
export const DOGEOS_L2SCAN_API_URL = "https://dogeos-testnet.l2scan.co/api";
export const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/price";
/** The manifest kind the Bark stack writes (scripts/lib/dogeosBarkStack.ts dogeosBarkManifestRecord). */
export const DOGEOS_BARK_MANIFEST_KIND = "dogeos-testnet-bark";

/** The three DogeOS keys (foundation). The route authority and the operator must be none of them. */
export const DOGEOS_TESTNET_ROLES = Object.freeze({
  deployer: "0x6c5C684D8ddf1D4338DBEd21beb7D342dC8382f8",
  oracleUpdater: "0x7dBDFe829309B4170346CF7e4496094CD126E9c1",
  graduationKeeper: "0xb07B9E70D1759Fc42103458039AaE2413026B078",
});

/**
 * Barkswap (Algebra Integral 1.2.1) and WDOGE on Chikyū (docs/dogeos/barkswap-facts.md section 1): external, used by
 * our contracts and the app, never verified by us. Same addresses as BARKSWAP in test/dogeos/barkswap/fixtures/barkswap.ts
 * (the stack fork spec compares them).
 */
export const BARKSWAP_EXTERNAL_ADDRESSES = Object.freeze({
  factory: "0xF3961157f56C983316657f0267B4C04460beE43f",
  poolDeployer: "0x4151224471B0EeA41eE4295c632cc61779d339C2",
  customPoolEntryPoint: "0x19B1A502Ea56843343E60e44a4a95B3cf4C914f5",
  swapRouter: "0x911E5A1630fD1768E5A1710DAAFaBb865cB79531",
  quoterV2: "0x187b41968063Cb8A04A5f4d2113844EF2Ba21493",
  nonfungiblePositionManager: "0xf596329a6c7E03F0708199cB5435f86783DB4302",
  wdoge: "0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE",
});

/**
 * keccak256 of each Barkswap contract's runtime code, read on Chikyū at the fork block 8,578,734 and unchanged at the
 * head on 2026-10-15. The deploy refuses to send anything if one of them differs (a replaced or redeployed contract
 * is a different venue and needs a new review).
 */
export const BARKSWAP_CODE_HASHES = Object.freeze({
  factory: "0xbb2129adf82eb524a4a7409ef826c540fbbd2f83866825c537c3542a01ce3e40",
  poolDeployer: "0x928c91f34cba233d03874c8dcb676838b0d0b49b8e0b901d8c9a039103658003",
  customPoolEntryPoint: "0xa67fd05a3d4ad339ab03332cba8acda32a1686f47aaf3440a2e9cbbd5f2163cd",
  swapRouter: "0xa35e040318c34b17c1fea875b854a0eff7d0b714ef185103741d9827daff3b89",
  quoterV2: "0xfc122271464cebcb3a0946eec2132154f1b718fcc61a2715057295ab1dd83ded",
  nonfungiblePositionManager: "0x692bd83d5948cd33fd0a6d08693ee6011ee5e480130f53983d87a03520cb9941",
  wdoge: "0xbd6ed8c4ef62daa1628f9d0259f01f08f1a3a085c71227865442c826cb1f2b5c",
});

/**
 * MwzBarkLauncher oracle inputs (F6; audited in docs/dogeos/barkswap-audit.md): band $0.01 - $10 per DOGE (18 decimals)
 * and the launcher's maxOracleAge, which bounds the GraduationOracle's own maxPriceAge.
 */
export const DOGEOS_BARK_LAUNCHER_BAND = Object.freeze({ minNativeUsd: 10n ** 16n, maxNativeUsd: 10n * 10n ** 18n, maxOracleAge: 3600n });
/** GraduationOracle.maxPriceAge on DogeOS (foundation "Staleness bound"); <= the launcher's maxOracleAge. */
export const DOGEOS_ORACLE_MAX_PRICE_AGE_SECONDS = 3600n;

const ZERO = "0x0000000000000000000000000000000000000000";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MODES = new Set(["chikyu", "chikyu-fork"]);
const BUILDS = new Set(["root", "bark"]);

function checksum(value) {
  const text = String(value ?? "").trim();
  if (!ADDRESS_RE.test(text)) return null;
  try {
    return getAddress(text);
  } catch {
    return null; // mixed case with a bad checksum
  }
}

function requireRecordAddress(label, value) {
  const a = checksum(value);
  if (!a || a === ZERO) throw new Error(`${label} is missing or not a non-zero address (${value})`);
  return a;
}

function requireUint(label, value) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw new Error(`${label} ${value} is not a non-negative integer`);
  return text;
}

function requireMode(mode) {
  if (!MODES.has(mode)) throw new Error(`unknown deploy mode ${mode} (expected chikyu or chikyu-fork)`);
  return mode;
}

// ---------------------------------------------------------------------------------------------------- guards

/**
 * Chikyū itself (network dogeosTestnet, chain 6281971) or the in-process hardhat network forking Chikyū
 * (hardhat.dogeos-bark-fork.config.ts, which reports 6281971). Nothing else: there is no 31337 path, the DOGE/USD
 * oracle and the launcher are 6281971-only.
 */
export function assertDogeosTarget({ chainId, networkName, forkUrl }) {
  const id = Number(chainId);
  if (id === DOGEOS_TESTNET_CHAIN_ID && networkName === DOGEOS_TESTNET_NETWORK_NAME) return { mode: "chikyu" };
  if (id === DOGEOS_TESTNET_CHAIN_ID && networkName === "hardhat" && String(forkUrl || "").trim()) return { mode: "chikyu-fork" };
  throw new Error(
    `refusing: network ${networkName} / chain ${chainId} is neither ${DOGEOS_TESTNET_NETWORK_NAME} on ${DOGEOS_TESTNET_CHAIN_ID} ` +
      `nor the hardhat fork of Chikyū (hardhat.dogeos-bark-fork.config.ts, chain ${DOGEOS_TESTNET_CHAIN_ID})`,
  );
}

/** The exact founder-go token under the deploy or the activate variable (each script reads only its own). */
export function assertBroadcastToken(value, envName = DOGEOS_DEPLOY_BROADCAST_ENV) {
  if (envName !== DOGEOS_DEPLOY_BROADCAST_ENV && envName !== DOGEOS_ACTIVATE_BROADCAST_ENV) {
    throw new Error(`unknown broadcast variable ${envName}`);
  }
  if (value !== DOGEOS_DEPLOY_BROADCAST_TOKEN) {
    throw new Error(`refusing to send: set ${envName}=${DOGEOS_DEPLOY_BROADCAST_TOKEN} (only with the founder's explicit go)`);
  }
  return true;
}

export function assertDeployerSigner(signer) {
  const a = checksum(signer);
  if (a !== DOGEOS_TESTNET_ROLES.deployer) {
    throw new Error(`refusing: signer ${signer} is not the DogeOS deployer ${DOGEOS_TESTNET_ROLES.deployer}`);
  }
  return a;
}

/** Chikyū: the pinned DogeOS deployer. Fork: the fork's own first signer, any non-zero address. */
function assertModeSigner(mode, signer) {
  if (requireMode(mode) === "chikyu") return assertDeployerSigner(signer);
  const a = checksum(signer);
  if (!a || a === ZERO) throw new Error(`refusing: fork signer ${signer} is not a non-zero address`);
  return a;
}

function requireEnvAddress(envName, value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`refusing: ${envName} is missing`);
  const a = checksum(text);
  if (!a) throw new Error(`refusing: ${envName} ${text} is not a valid address`);
  if (a === ZERO) throw new Error(`refusing: ${envName} is the zero address`);
  return a;
}

/**
 * The public route-authority address: present, valid, non-zero, none of the three DogeOS keys and not the signer.
 * On Chikyū it must also be the pinned DOGEOS_TESTNET_ROUTE_AUTHORITY; the fork keeps the looser rule.
 */
export function resolveRouteAuthority(value, { mode, signer } = {}) {
  requireMode(mode);
  const a = requireEnvAddress(DOGEOS_ROUTE_AUTHORITY_ENV, value);
  const roles = [
    [DOGEOS_TESTNET_ROLES.deployer, "the deployer"],
    [DOGEOS_TESTNET_ROLES.oracleUpdater, "the oracle updater"],
    [DOGEOS_TESTNET_ROLES.graduationKeeper, "the graduation keeper"],
  ];
  if (signer) roles.push([checksum(signer), "the signer"]);
  for (const [role, label] of roles) {
    if (a === role) throw new Error(`refusing: ${DOGEOS_ROUTE_AUTHORITY_ENV} ${a} is ${label}; the route authority must be its own key`);
  }
  if (mode === "chikyu" && a !== DOGEOS_TESTNET_ROUTE_AUTHORITY) {
    throw new Error(`refusing: ${DOGEOS_ROUTE_AUTHORITY_ENV} ${a} is not the DogeOS route authority ${DOGEOS_TESTNET_ROUTE_AUTHORITY}`);
  }
  return a;
}

/**
 * The DogeOS operator (spec B9, the fifth key): present, valid, non-zero, and none of the deployer, the oracle updater,
 * the graduation keeper (which holds no contract role), the route authority (the given one and the pinned DogeOS one)
 * and the signer. No pin in either mode: the founder supplies the address (plan t29).
 */
export function resolveOperator(value, { mode, signer, routeAuthority } = {}) {
  requireMode(mode);
  const ra = checksum(routeAuthority);
  if (!ra || ra === ZERO) throw new Error("resolveOperator needs the resolved route authority to compare against");
  const a = requireEnvAddress(DOGEOS_OPERATOR_ENV, value);
  const roles = [
    [DOGEOS_TESTNET_ROLES.deployer, "the deployer"],
    [DOGEOS_TESTNET_ROLES.oracleUpdater, "the oracle updater"],
    [DOGEOS_TESTNET_ROLES.graduationKeeper, "the graduation keeper"],
    [ra, "the route authority"],
    [DOGEOS_TESTNET_ROUTE_AUTHORITY, "the DogeOS route authority"],
  ];
  if (signer) roles.push([checksum(signer), "the signer"]);
  for (const [role, label] of roles) {
    if (a === role) throw new Error(`refusing: ${DOGEOS_OPERATOR_ENV} ${a} is ${label}; the operator must be its own key (spec B9)`);
  }
  return a;
}

/**
 * Order: network, broadcast token, signer, route authority, operator, no earlier output. existingOutputs lists the
 * output files (manifest, verification JSON) that already exist; any one of them refuses the run.
 */
export function assertDeployGuards({ chainId, networkName, forkUrl, broadcastToken, signer, routeAuthority, operator, existingOutputs }) {
  const { mode } = assertDogeosTarget({ chainId, networkName, forkUrl });
  assertBroadcastToken(broadcastToken, DOGEOS_DEPLOY_BROADCAST_ENV);
  const s = assertModeSigner(mode, signer);
  const ra = resolveRouteAuthority(routeAuthority, { mode, signer: s });
  const op = resolveOperator(operator, { mode, signer: s, routeAuthority: ra });
  if (!Array.isArray(existingOutputs)) throw new Error("existingOutputs must list the output files that already exist");
  if (existingOutputs.length) {
    throw new Error(`refusing: output(s) already exist: ${existingOutputs.join(", ")}; refusing to deploy a second stack over them`);
  }
  return { mode, signer: s, routeAuthority: ra, operator: op };
}

/** Activate: the same network, signer and route-authority guards as deploy, under DOGEOS_TESTNET_ACTIVATE_BROADCAST. */
export function assertActivateGuards({ chainId, networkName, forkUrl, broadcastToken, signer, routeAuthority }) {
  const { mode } = assertDogeosTarget({ chainId, networkName, forkUrl });
  assertBroadcastToken(broadcastToken, DOGEOS_ACTIVATE_BROADCAST_ENV);
  const s = assertModeSigner(mode, signer);
  const ra = resolveRouteAuthority(routeAuthority, { mode, signer: s });
  return { mode, signer: s, routeAuthority: ra };
}

/** observed = { [key of BARKSWAP_EXTERNAL_ADDRESSES]: keccak256(runtime code) } as read on the target chain. */
export function assertBarkswapCode(observed) {
  for (const [key, pin] of Object.entries(BARKSWAP_CODE_HASHES)) {
    const address = BARKSWAP_EXTERNAL_ADDRESSES[key];
    const got = observed?.[key];
    if (typeof got !== "string" || !got) throw new Error(`refusing: Barkswap ${key} ${address}: no code hash read`);
    if (got.toLowerCase() !== pin) {
      throw new Error(`refusing: Barkswap ${key} ${address} code hash ${got} is not the pinned ${pin} (docs/dogeos/barkswap-facts.md)`);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------- price

/** Binance /api/v3/ticker/price body -> USD price with 8 decimals (extra digits truncated). Refuses <= 0. */
export function parseBinanceUsd8(body, symbol) {
  if (!body || typeof body !== "object") throw new Error(`Binance ${symbol}: no ticker body`);
  if (body.symbol !== symbol) throw new Error(`Binance ${symbol}: ticker symbol is ${body.symbol}`);
  const price = body.price;
  if (typeof price !== "string" || !/^\d+(\.\d+)?$/.test(price)) throw new Error(`Binance ${symbol}: malformed price ${String(price)}`);
  const [whole, frac = ""] = price.split(".");
  const value = BigInt(whole) * 10n ** 8n + BigInt((frac + "00000000").slice(0, 8));
  if (value <= 0n) throw new Error(`Binance ${symbol}: price ${price} must be > 0 at 8 decimals`);
  return value;
}

/** Fetches the spot price at run time. fetchImpl is the WHATWG fetch (injected so tests never reach Binance). */
export async function fetchBinanceUsd8(symbol, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error(`Binance ${symbol}: no fetch implementation`);
  const url = `${BINANCE_TICKER_URL}?symbol=${symbol}`;
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new Error(`Binance ${symbol}: request failed: ${error?.message || error}`);
  }
  if (!response.ok) throw new Error(`Binance ${symbol}: HTTP ${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`Binance ${symbol}: response is not JSON: ${error?.message || error}`);
  }
  return parseBinanceUsd8(body, symbol);
}

/** amount * fromUsd / toUsd (both prices at the same decimals): the ETH testnet caps re-priced to DOGE. */
export function rescaleNative(amount, fromUsd8, toUsd8) {
  if (BigInt(fromUsd8) <= 0n || BigInt(toUsd8) <= 0n) throw new Error("rescaleNative: both USD prices must be positive");
  return (BigInt(amount) * BigInt(fromUsd8)) / BigInt(toUsd8);
}

/**
 * MwzBarkCreatorChoiceVault.setCaps arguments in DOGE: the gen-8 testnet caps (TESTNET_CAPS in
 * scripts/deploy-robinhood-testnet-gen6-fees.ts, in ETH; gen-8's 46630 deploy used the same values) re-priced at the
 * run's Binance ETHUSDT / DOGEUSDT. Seconds and bps are unchanged; maxImpactBps must stay within the vault's limit (50).
 */
export function choiceVaultCapsInDoge(ethCaps, { ethUsd8, dogeUsd8 }) {
  const doge = (v) => {
    const out = rescaleNative(BigInt(v), ethUsd8, dogeUsd8);
    if (out <= 0n) throw new Error(`choice-vault cap ${v} rounds to 0 DOGE at ETHUSDT ${ethUsd8} / DOGEUSDT ${dogeUsd8}`);
    return out;
  };
  const maxImpactBps = BigInt(ethCaps.maxImpactBps);
  if (maxImpactBps <= 0n || maxImpactBps > 50n) throw new Error(`choice-vault maxImpactBps ${maxImpactBps} must be in (0, 50]`);
  return {
    maxBuyPerTx: doge(ethCaps.maxBuyPerTx),
    maxBuybackPerCoinWeek: doge(ethCaps.maxBuybackPerCampaignWeek),
    minBuyInterval: BigInt(ethCaps.minBuyInterval),
    maxImpactBps,
    maxHolderBatchPerWeek: doge(ethCaps.maxHolderBatchPerWeek),
  };
}

// ---------------------------------------------------------------------------------------------------- output paths

/**
 * Chikyū writes the repo manifest and verification JSON. A fork run never writes into the repo: it writes to
 * forkDir (a temp directory), or to the DOGEOS_TESTNET_MANIFEST override, which only a fork may use.
 */
export function dogeosOutputPaths({ mode, root, forkDir, manifestOverride }) {
  const override = String(manifestOverride || "").trim();
  if (mode === "chikyu") {
    if (override) throw new Error(`refusing: the ${DOGEOS_MANIFEST_OVERRIDE_ENV} manifest override is for a fork run only`);
    return { manifest: path.join(root, ...DOGEOS_MANIFEST_PATH.split("/")), verification: path.join(root, ...DOGEOS_VERIFICATION_PATH.split("/")) };
  }
  if (mode === "chikyu-fork") {
    if (!forkDir) throw new Error("a fork run needs a forkDir (temp directory) for its outputs");
    const rel = path.relative(path.resolve(root), path.resolve(forkDir));
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) throw new Error(`refusing: fork output dir ${forkDir} is inside the repo`);
    const manifest = override ? path.resolve(override) : path.join(forkDir, path.basename(DOGEOS_MANIFEST_PATH));
    return { manifest, verification: path.join(path.dirname(manifest), path.basename(DOGEOS_VERIFICATION_PATH)) };
  }
  throw new Error(`unknown deploy mode ${mode}`);
}

export function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const json = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  fs.writeFileSync(file, `${json}\n`);
}

// ---------------------------------------------------------------------------------------------------- verification

const sol = (file, name) => `contracts/${file}.sol:${name}`;
export const BARK_LAUNCH_LIB_FQN = sol("dogeos/barkswap/libraries/MwzBarkLaunchLib", "MwzBarkLaunchLib");
export const BARK_FEE_BOOKS_FQN = sol("dogeos/barkswap/libraries/MwzBarkFeeBooks", "MwzBarkFeeBooks");

/** The Bark contracts the stack deploys (manifest `deployed` keys), in deploy order. */
export const BARK_DEPLOYED_KEYS = Object.freeze([
  "MwzBarkLaunchLib",
  "MwzBarkFeeBooks",
  "MwzBarkCreatorEscrow",
  "MwzBarkFeeSplitter",
  "MwzBarkCreatorChoiceVault",
  "MwzBarkReserveLock",
  "MwzBarkPlugin",
  "MwzBarkLauncher",
  "MwzBarkLaunchLens",
]);

/**
 * Every contract the DogeOS Bark stack deploys, with the constructor arguments deployDogeosBarkStack
 * (scripts/lib/dogeosBarkStack.ts) passes, and the build that verifies it:
 *   "root"  reused unchanged on the root 0.8.24 build (hardhat.dogeos-verify.config.ts): the DOGE/USD oracle,
 *           GraduationOracle and the vaults gen-8 routes into;
 *   "bark"  the Bark build (0.8.26, hardhat.dogeos-bark-verify.config.ts): the two launcher libraries and the seven
 *           Bark contracts; the launcher with its linked libraries.
 * Barkswap and WDOGE are external and not listed. Arguments are strings except the oracle's bool, which stays a JSON
 * boolean (a string "false" would encode true).
 */
export function dogeosVerificationEntries(record) {
  if (Number(record?.chainId) !== DOGEOS_TESTNET_CHAIN_ID) throw new Error(`manifest chainId ${record?.chainId} is not ${DOGEOS_TESTNET_CHAIN_ID}`);
  if (record.kind !== DOGEOS_BARK_MANIFEST_KIND) throw new Error(`manifest kind ${record.kind} is not ${DOGEOS_BARK_MANIFEST_KIND}`);
  const r = (label, v) => requireRecordAddress(label, v);
  const A = r("admin", record.admin);
  const RA = r("routeAuthority", record.routeAuthority);
  const operator = resolveOperator(record.operator, { mode: "chikyu-fork", signer: A, routeAuthority: RA });
  const x = record.barkswap || {};
  for (const [key, pin] of Object.entries(BARKSWAP_EXTERNAL_ADDRESSES)) {
    if (checksum(x[key]) !== pin) throw new Error(`barkswap.${key} ${x[key]} is not the pinned Barkswap address ${pin}`);
  }
  const o = record.oracle || {};
  const v = record.vaults || {};
  const lc = record.launcherConfig || {};
  const d = record.deployed || {};
  const D = Object.fromEntries(BARK_DEPLOYED_KEYS.map((k) => [k, r(`deployed.${k}`, d[k])]));
  const O1 = r("oracle.dogeUsd", o.dogeUsd);
  const O2 = r("oracle.graduationOracle", o.graduationOracle);
  const initialAnswer = String(o.initialAnswer ?? "");
  if (!/^\d+$/.test(initialAnswer) || BigInt(initialAnswer) <= 0n) throw new Error(`oracle.initialAnswer ${o.initialAnswer} is not a positive integer`);
  const V = {
    weekly: r("vaults.weekly", v.weekly),
    charity: r("vaults.charity", v.charity),
    monthly: r("vaults.monthly", v.monthly),
    recruiter: r("vaults.recruiter", v.recruiter),
    protocol: r("vaults.protocol", v.protocol),
    community: r("vaults.community", v.community),
    holderDistributor: r("vaults.holderDistributor", v.holderDistributor),
    airdropDistributor: r("vaults.airdropDistributor", v.airdropDistributor),
  };
  const monthlyCapUsd = requireUint("vaults.monthlyCapUsd", v.monthlyCapUsd);
  const holderBatchDelay = requireUint("choiceVault.holderBatchDelay", record.choiceVault?.holderBatchDelay);
  const root = (name, address, file, contract, args) => ({ name, address, contract: sol(file, contract), args, build: "root" });
  const bark = (name, args, extra = {}) => ({
    name,
    address: D[name],
    contract: name === "MwzBarkLaunchLib" ? BARK_LAUNCH_LIB_FQN : name === "MwzBarkFeeBooks" ? BARK_FEE_BOOKS_FQN : sol(`dogeos/barkswap/${name}`, name),
    args,
    build: "bark",
    ...extra,
  });
  const L = D.MwzBarkLauncher;
  return [
    root("DogeosTestnetDogeUsdOracle", O1, "dogeos/testnet/DogeosTestnetDogeUsdOracle", "DogeosTestnetDogeUsdOracle", [r("oracle.updater", o.updater), initialAnswer, false]),
    root("GraduationOracle", O2, "GraduationOracle", "GraduationOracle", [O1, requireUint("oracle.maxPriceAge", o.maxPriceAge)]),
    root("TreasuryVaultV2 (weekly)", V.weekly, "TreasuryVaultV2", "TreasuryVaultV2", [A, ZERO, A]),
    root("CharityTreasury", V.charity, "CharityTreasury", "CharityTreasury", [A]),
    root("MonthlyLeagueTreasury", V.monthly, "MonthlyLeagueTreasury", "MonthlyLeagueTreasury", [A, A, O2, V.charity, monthlyCapUsd]),
    root("RecruiterRewardsVault", V.recruiter, "RecruiterRewardsVault", "RecruiterRewardsVault", [A]),
    root("ProtocolRevenueVault", V.protocol, "ProtocolRevenueVault", "ProtocolRevenueVault", [A]),
    root("RewardDistributor (holders)", V.holderDistributor, "RewardDistributor", "RewardDistributor", [A]),
    root("RewardDistributor (airdrop)", V.airdropDistributor, "RewardDistributor", "RewardDistributor", [A]),
    root("CommunityRewardsVault", V.community, "CommunityRewardsVault", "CommunityRewardsVault", [A, D.MwzBarkFeeSplitter]),
    bark("MwzBarkLaunchLib", []),
    bark("MwzBarkFeeBooks", []),
    bark("MwzBarkCreatorEscrow", [L]),
    bark("MwzBarkFeeSplitter", [L, A, V.weekly, V.monthly, V.recruiter, V.community, V.protocol, operator]),
    bark("MwzBarkCreatorChoiceVault", [A, L, holderBatchDelay]),
    bark("MwzBarkReserveLock", [L]),
    bark("MwzBarkPlugin", [L, BARKSWAP_EXTERNAL_ADDRESSES.wdoge, D.MwzBarkCreatorEscrow, D.MwzBarkCreatorChoiceVault]),
    bark(
      "MwzBarkLauncher",
      [
        BARKSWAP_EXTERNAL_ADDRESSES.customPoolEntryPoint,
        BARKSWAP_EXTERNAL_ADDRESSES.wdoge,
        D.MwzBarkPlugin,
        O2,
        D.MwzBarkReserveLock,
        D.MwzBarkCreatorChoiceVault,
        A,
        RA,
        D.MwzBarkFeeSplitter,
        requireUint("launcherConfig.minNativeUsd", lc.minNativeUsd),
        requireUint("launcherConfig.maxNativeUsd", lc.maxNativeUsd),
        requireUint("launcherConfig.maxOracleAge", lc.maxOracleAge),
      ],
      { libraries: { [BARK_LAUNCH_LIB_FQN]: D.MwzBarkLaunchLib, [BARK_FEE_BOOKS_FQN]: D.MwzBarkFeeBooks } },
    ),
    bark("MwzBarkLaunchLens", [L]),
  ];
}

export function dogeosVerificationManifest(record, entries) {
  return {
    purpose:
      "Every contract deployed on DogeOS Chikyu testnet (6281971) for the Bark stack (gen-8 on Barkswap custom pools), with the constructor arguments it was created with and the build that verifies it, for L2Scan source verification (scripts/verify-dogeos-testnet.ts: build root with hardhat.dogeos-verify.config.ts, build bark with hardhat.dogeos-bark-verify.config.ts). Barkswap (Algebra factory, entry point, routers, quoter, NPM) and WDOGE are external and not verified by us.",
    deployer: requireRecordAddress("deployer", record.deployer),
    chains: {
      [String(DOGEOS_TESTNET_CHAIN_ID)]: {
        network: DOGEOS_TESTNET_NETWORK_NAME,
        provider: "l2scan",
        apiUrl: DOGEOS_L2SCAN_API_URL,
        contracts: entries,
      },
    },
  };
}

/** Reads chains["6281971"].contracts back and refuses anything malformed or external. */
export function readVerificationList(manifest) {
  const list = manifest?.chains?.[String(DOGEOS_TESTNET_CHAIN_ID)]?.contracts;
  if (!Array.isArray(list)) throw new Error(`verification JSON has no chains["${DOGEOS_TESTNET_CHAIN_ID}"].contracts`);
  const external = new Set(Object.values(BARKSWAP_EXTERNAL_ADDRESSES).map((a) => a.toLowerCase()));
  const fqn = /^contracts\/[\w/]+\.sol:\w+$/;
  return list.map((e, i) => {
    const label = `entry ${i} (${e?.name})`;
    if (!e || typeof e.name !== "string" || !e.name) throw new Error(`${label}: name missing`);
    const address = checksum(e.address);
    if (!address || address === ZERO) throw new Error(`${label}: address ${e.address} invalid`);
    if (external.has(address.toLowerCase())) throw new Error(`${label}: ${address} is an external Barkswap/WDOGE contract; we never verify it`);
    if (typeof e.contract !== "string" || !fqn.test(e.contract)) throw new Error(`${label}: contract must be a fully qualified name`);
    if (!Array.isArray(e.args)) throw new Error(`${label}: args must be an array`);
    if (!BUILDS.has(e.build)) throw new Error(`${label}: build ${e.build} is neither root nor bark`);
    const out = { name: e.name, address, contract: e.contract, args: e.args, build: e.build };
    if (e.libraries !== undefined) {
      if (!e.libraries || typeof e.libraries !== "object") throw new Error(`${label}: libraries must be an object`);
      out.libraries = Object.fromEntries(
        Object.entries(e.libraries).map(([lib, a]) => {
          const la = checksum(a);
          if (!fqn.test(lib) || !la || la === ZERO) throw new Error(`${label}: library ${lib} -> ${a} invalid`);
          return [lib, la];
        }),
      );
    }
    return out;
  });
}

/** The build a verify run serves, from the hardhat config's artifacts directory: artifacts -> root, artifacts-bark -> bark. */
export function verificationBuildOf(artifactsDir) {
  const base = artifactsDir ? path.basename(path.resolve(String(artifactsDir))) : "";
  if (base === "artifacts") return "root";
  if (base === "artifacts-bark") return "bark";
  throw new Error(`verify runs with the root build (artifacts) or the Bark build (artifacts-bark), not ${artifactsDir}`);
}

export function entriesForBuild(list, build) {
  if (!BUILDS.has(build)) throw new Error(`unknown verification build ${build} (root or bark)`);
  return list.filter((e) => e.build === build);
}

/** Verify runs only against Chikyū, with an L2Scan custom chain from one of the two DogeOS verify configs. */
export function assertVerifyTarget({ chainId, networkName, explorerApiUrl }) {
  if (networkName !== DOGEOS_TESTNET_NETWORK_NAME) throw new Error(`refusing: verify runs only on --network ${DOGEOS_TESTNET_NETWORK_NAME} (got ${networkName})`);
  if (Number(chainId) !== DOGEOS_TESTNET_CHAIN_ID) throw new Error(`refusing: chain ${chainId} is not ${DOGEOS_TESTNET_CHAIN_ID}`);
  if (explorerApiUrl !== DOGEOS_L2SCAN_API_URL) {
    throw new Error(
      `refusing: no L2Scan custom chain for ${DOGEOS_TESTNET_NETWORK_NAME}; run with --config hardhat.dogeos-verify.config.ts (reused contracts) or hardhat.dogeos-bark-verify.config.ts (Bark contracts)`,
    );
  }
  return true;
}

/** The verification JSON must be exactly the entries the manifest implies (same contracts, addresses, args, libraries). */
export function assertVerificationMatchesManifest(list, manifest) {
  if (Number(manifest?.chainId) !== DOGEOS_TESTNET_CHAIN_ID) throw new Error(`manifest chainId ${manifest?.chainId} is not ${DOGEOS_TESTNET_CHAIN_ID}`);
  const expected = dogeosVerificationEntries(manifest);
  const got = Array.isArray(list) ? list : [];
  if (got.length !== expected.length) {
    throw new Error(`refusing: verification JSON (${got.length} entries) does not match the manifest (${expected.length} entries)`);
  }
  const canon = (e) => JSON.stringify({ ...e, address: checksum(e.address), libraries: e.libraries ?? null });
  expected.forEach((e, i) => {
    if (canon(got[i]) !== canon(e)) throw new Error(`refusing: verification JSON entry ${e.name} does not match the manifest`);
  });
  return true;
}

export function isAlreadyVerified(error) {
  const message = typeof error === "string" ? error : String(error?.message || "");
  return /already (been )?verified/i.test(message);
}

// ---------------------------------------------------------------------------------------------------- activate

/**
 * Activation preconditions from the manifest and the launcher's on-chain state:
 *   onchain = { hasCode, owner, createSigner, oracle, minNativeUsd, maxNativeUsd, createPaused } read from
 *             deployed.MwzBarkLauncher
 *   oracleProbe = { ok: true, price } | { ok: false, error } from GraduationOracle.nativeUsdPrice() (18 decimals)
 * Returns the launcher and the one call activation sends: setCreatePaused(false). The full stack read-back
 * (readBackDogeosBarkStack) runs before this in the script.
 * Chikyū: the signer is the pinned deployer, and the env route authority, the manifest's and createSigner() must all be
 * the pinned DOGEOS_TESTNET_ROUTE_AUTHORITY. Fork: the signer must be the manifest's admin and owner (the fork deploy's
 * own signer), and createSigner() must equal the (fork-local) env route authority. The price must be inside the
 * launcher's band, or every launch would revert.
 */
export function planActivation({ mode, manifest, expectedRouteAuthority, signer, onchain, oracleProbe }) {
  requireMode(mode);
  if (Number(manifest?.chainId) !== DOGEOS_TESTNET_CHAIN_ID) throw new Error(`manifest chainId ${manifest?.chainId} is not ${DOGEOS_TESTNET_CHAIN_ID}`);
  const launcher = requireRecordAddress("manifest deployed.MwzBarkLauncher", manifest?.deployed?.MwzBarkLauncher);
  const manifestOracle = requireRecordAddress("manifest oracle.graduationOracle", manifest?.oracle?.graduationOracle);
  const s = assertModeSigner(mode, signer);
  if (mode === "chikyu-fork") {
    if (checksum(manifest.admin) !== s) throw new Error(`refusing: fork signer ${s} is not the manifest's admin ${manifest.admin}`);
    if (checksum(manifest.owner) !== s) throw new Error(`refusing: fork signer ${s} is not the manifest's owner ${manifest.owner}`);
  }
  const expected = resolveRouteAuthority(expectedRouteAuthority, { mode, signer: s });
  if (checksum(manifest.routeAuthority) !== expected) {
    throw new Error(`refusing: manifest routeAuthority ${manifest.routeAuthority} is not ${DOGEOS_ROUTE_AUTHORITY_ENV} ${expected}`);
  }
  resolveOperator(manifest.operator, { mode, signer: s, routeAuthority: expected });
  if (!onchain?.hasCode) throw new Error(`launcher ${launcher} has no code on chain ${DOGEOS_TESTNET_CHAIN_ID}`);
  if (checksum(onchain.createSigner) !== expected) {
    throw new Error(`refusing: launcher createSigner() ${onchain.createSigner} is not ${DOGEOS_ROUTE_AUTHORITY_ENV} ${expected}`);
  }
  if (checksum(onchain.owner) !== s) throw new Error(`refusing: launcher owner() ${onchain.owner} is not the signer ${s}`);
  if (checksum(onchain.oracle) !== manifestOracle) {
    throw new Error(`refusing: launcher oracle() ${onchain.oracle} is not the manifest's GraduationOracle ${manifestOracle}`);
  }
  const { minNativeUsd, maxNativeUsd } = DOGEOS_BARK_LAUNCHER_BAND;
  if (BigInt(onchain.minNativeUsd ?? -1) !== minNativeUsd) throw new Error(`refusing: launcher minNativeUsd() ${onchain.minNativeUsd} is not ${minNativeUsd}`);
  if (BigInt(onchain.maxNativeUsd ?? -1) !== maxNativeUsd) throw new Error(`refusing: launcher maxNativeUsd() ${onchain.maxNativeUsd} is not ${maxNativeUsd}`);
  if (!oracleProbe || oracleProbe.ok !== true) {
    throw new Error(`refusing: GraduationOracle.nativeUsdPrice() reverted (${oracleProbe?.error ?? "no probe"}); push a fresh DOGE/USD answer first`);
  }
  if (!(typeof oracleProbe.price === "bigint" && oracleProbe.price > 0n)) {
    throw new Error(`refusing: GraduationOracle.nativeUsdPrice() returned ${oracleProbe.price}`);
  }
  if (oracleProbe.price < minNativeUsd || oracleProbe.price > maxNativeUsd) {
    throw new Error(`refusing: GraduationOracle.nativeUsdPrice() ${oracleProbe.price} is outside the launcher band [${minNativeUsd}, ${maxNativeUsd}]`);
  }
  if (onchain.createPaused === false) throw new Error(`launcher ${launcher} is already open for creates; nothing to activate`);
  return { launcher, calls: ["setCreatePaused(false)"] };
}

export function assertActivated({ createPaused } = {}) {
  if (createPaused !== false) throw new Error(`activation read-back failed: expected createPaused()==false, got createPaused=${createPaused}`);
  return true;
}
