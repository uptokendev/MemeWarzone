/**
 * EVM generation 8 create authorization (D3: our API signs CREATE only; trading is never signed).
 *
 * POST /api/routing/create-authorization with the chain's gen-8 launcher as factoryAddress (or launcherAddress, or
 * generation: 8), and POST /api/routing/gen8/create-authorization. The signature is exactly what MwzV4Launcher
 * verifies (contracts/gen8/MwzV4Launcher.sol hashRequest / authorizationDigest / _consumeAuthorization):
 *
 *   payload = keccak256(abi.encode(keccak256("MWZ_GEN8_CREATE_AUTH"), chainId, launcher, creator,
 *                                  hashRequest(req), uint64 deadline))
 *   digest  = EIP-191 personal_sign hash of the 32 payload bytes; signer = launcher.createSigner()
 *   req     = (name, symbol, logoURI, xAccount, website, extraLink, metadataHash, targetUsd, feeChoice,
 *              feeCreatorPct, firstBuyValue, minFirstBuyOut, salt, uint64 openAt);  msg.value must equal firstBuyValue
 *   deadline <= now + 1 day on chain; the API uses ROUTE_AUTH_TTL_SECONDS (default 600 s, capped at 1 day)
 *   openAt  B scheduled trading open (campaignRequest.openAt, unix seconds): absent, 0 or not in the future = 0 (trading
 *           opens at launch); otherwise at most now + 30 days (MAX_OPEN_DELAY) minus the authorization TTL, so a
 *           launch inside the authorization's lifetime can never revert OpenAtTooFar
 *
 * The creator (msg.sender of launch) is bound into the digest, so nobody else can use the signature, and the digest
 * is single use on chain. Preflight as the gen-7 create path: the go-live canary, the wallet's create preflight (bans,
 * restrictions, OPEN_CREATOR_CHAIN_IDS creator rules; security.js), then the launcher on chain (code, not paused,
 * createSigner == our key, target allowed, oracle plan readable). Every signature is logged to
 * route_authorization_log (route_kind 'create', metadata.generation.factoryGeneration 8).
 *
 * Key: EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY, else the route authority key the gen-7 path uses.
 *
 * Barkswap venue (DogeOS 6281971; barkswap plan t21, spec section 3 launcher row / section 4 API, B9): the same request,
 * hash, payload and checks against MwzBarkLauncher (its hashRequest / authorizationDigest / CREATE_AUTH_TYPE are
 * gen-8's; the digest binds the chain id and the Bark launcher, so neither authorization replays on the other venue).
 * Differences: the preflight reads plugin() (not hook()) and wNative(), the plan carries liqA / liqB, the first buy is
 * estimated on the Algebra pool (shared/evmGen8Bark.mjs), and the salt is not just random: the API searches one whose
 * CREATE2 coin sorts below WDOGE (launch() reverts CoinNotBelowWNative otherwise; api/lib/evmGen8Bark.js). The
 * response and the log add `venue: "barkswap"` and the predicted coin. The signer is the DogeOS route-authority key
 * (B9): on a Barkswap chain gen8CreateSigner ignores EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY.
 */
import crypto from "node:crypto";
import { ethers } from "ethers";
import {
  EVM_GEN8_CAMPAIGN_GENERATION,
  EVM_GEN8_FACTORY_GENERATION,
  GEN8_FEE_CHOICES,
  GEN8_FEE_CHOICE_NAMES,
  GEN8_FIRST_BUY_MAX,
  GEN8_MAX_OPEN_DELAY_SECONDS,
  GEN8_TARGET_DEFAULT_USD,
  GEN8_TARGET_TEST_USD,
  GEN8_TRADE_PATH,
  GEN8_VENUE_BARKSWAP,
  gen8AuthorizationPayload,
  gen8FirstBuyEstimate,
  gen8HashRequest,
  gen8LaunchRequestJson,
  gen8MetadataHash,
  gen8RevertReason,
  gen8VenueFor,
  isGen8TargetAllowed,
} from "../../shared/evmGen8.mjs";
import { barkFirstBuyEstimate } from "../../shared/evmGen8Bark.mjs";
import { gen8ConfigFor, isGen8BarkConfig } from "../lib/evmGen8Config.js";
import { BARK_LAUNCHER_ABI, findBarkCoinSalt } from "../lib/evmGen8Bark.js";
import { strictEvmWallet } from "../lib/evmGen8StrictWallet.js";
import { createCanaryRefusalBody, isCreateAllowedForWallet } from "../lib/createCanary.js";

export { strictEvmWallet } from "../lib/evmGen8StrictWallet.js";

export const GEN8_LAUNCHER_PREFLIGHT_ABI = [
  "function createPaused() view returns (bool)",
  "function createSigner() view returns (address)",
  "function hook() view returns (address)",
  "function isGraduationTargetAllowed(uint256 target) view returns (bool)",
  "function plan(uint256 targetUsdWad) view returns (uint256 mc, uint256 vN, uint256 vT, int24 tickStart, int24 tickGrad)",
  "function MAX_AUTH_TTL() view returns (uint256)",
];

const MAX_AUTH_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_FIRST_BUY_SLIPPAGE_BPS = 300;
const MAX_FIRST_BUY_SLIPPAGE_BPS = 5000;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export class Gen8CreateError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.httpStatus = status;
    this.code = code;
    this.details = details;
  }
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

/**
 * The gen-8 create signer: EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY, else `fallbackKey` (the route authority key). On a
 * Barkswap chain (`chainId` on that venue) only `fallbackKey`: the DogeOS create signer is the route-authority key (B9).
 */
export function gen8CreateSigner(env = process.env, fallbackKey = "", chainId = null) {
  const barkswap = chainId != null && gen8VenueFor(chainId) === GEN8_VENUE_BARKSWAP;
  const key = (barkswap ? "" : String(env.EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY || "").trim()) || String(fallbackKey || "").trim();
  if (!key) return null;
  try {
    return new ethers.Wallet(key);
  } catch {
    return null;
  }
}

/** True when the body asks for a gen-8 create on a chain where gen-8 is configured (either venue). */
export function isGen8CreateRequest(body, env = process.env) {
  const chainId = Number(body?.chainId);
  const cfg = gen8ConfigFor(chainId, env);
  if (!cfg) return false;
  if (Number(body?.generation) === EVM_GEN8_FACTORY_GENERATION) return true;
  const target = String(body?.launcherAddress || body?.factoryAddress || "").trim().toLowerCase();
  return Boolean(target && target === cfg.launcher.toLowerCase());
}

function parseUintField(value, label, fallback = null) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== null) return fallback;
    throw new Gen8CreateError(400, "GEN8_CREATE_FIELD_INVALID", `${label} is required`);
  }
  try {
    const n = BigInt(String(value).trim());
    if (n < 0n) throw new Error("negative");
    return n;
  } catch {
    throw new Gen8CreateError(400, "GEN8_CREATE_FIELD_INVALID", `${label} must be a non-negative integer (wei)`);
  }
}

function parseFeeChoice(source) {
  const raw = source.feeChoice ?? source.feeChoiceId ?? source.feeChoiceName ?? "keep";
  const id = typeof raw === "string" && !/^\d+$/.test(raw.trim()) ? GEN8_FEE_CHOICES[raw.trim().toLowerCase()] : Number(raw);
  if (!GEN8_FEE_CHOICE_NAMES[id]) throw new Gen8CreateError(400, "GEN8_FEE_CHOICE_INVALID", "feeChoice must be keep, holders, split or buyback (1 to 4)");
  let pct = Number(source.feeCreatorPct ?? 0);
  if (!Number.isInteger(pct)) throw new Gen8CreateError(400, "GEN8_FEE_CHOICE_INVALID", "feeCreatorPct must be an integer");
  if (id === GEN8_FEE_CHOICES.split) {
    if (pct < 1 || pct > 99) throw new Gen8CreateError(400, "GEN8_FEE_CHOICE_INVALID", "A split fee choice needs feeCreatorPct between 1 and 99");
  } else if (pct !== 0) {
    pct = 0; // only split carries a percentage; the launcher refuses any other value
  }
  return { id, pct };
}

// Text limits (audit B-04). Name and symbol match the create page (src/constants/validation.ts NAME_MAX_LENGTH 32,
// TICKER_MAX_LENGTH 10), counted in UTF-8 bytes as the chain stores them. URIs match the app's on-chain logo limit
// (src/lib/onchainLogoUri.ts, 512). The description matches the create page's textarea maxLength (DESCRIPTION_MAX_LENGTH
// 1000, UTF-16 code units, which is what String.length counts).
export const GEN8_NAME_MAX_BYTES = 32;
export const GEN8_SYMBOL_MAX_BYTES = 10;
export const GEN8_URI_MAX_BYTES = 512;
export const GEN8_DESCRIPTION_MAX_LENGTH = 1000;
// C0 controls, DEL, C1 controls, zero-width and bidi controls, BOM.
const GEN8_FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;
// The description is a multi-line textarea: newline, carriage return and tab are allowed there, nothing else above.
const GEN8_FORBIDDEN_DESCRIPTION_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;
// The app uploads the logo and sends an https URL (src/lib/onchainLogoUri.ts refuses data: URLs); ipfs:// is the
// other form a hosted logo takes. data: and anything else are refused.
const GEN8_LOGO_URI_SCHEME = /^(https|ipfs):\/\//i;

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function checkGen8Text(value, label, { maxBytes = null, maxLength = null, forbidden = GEN8_FORBIDDEN_CHARS } = {}) {
  if (forbidden.test(value)) {
    throw new Gen8CreateError(400, "GEN8_CREATE_FIELD_INVALID", `${label} contains control, zero-width or bidi characters`);
  }
  if (maxBytes !== null && utf8Bytes(value) > maxBytes) {
    throw new Gen8CreateError(400, "GEN8_CREATE_FIELD_INVALID", `${label} is longer than ${maxBytes} bytes`);
  }
  if (maxLength !== null && value.length > maxLength) {
    throw new Gen8CreateError(400, "GEN8_CREATE_FIELD_INVALID", `${label} is longer than ${maxLength} characters`);
  }
}

/** The authorization lifetime the API signs: ROUTE_AUTH_TTL_SECONDS, default 600 s, capped at 1 day (MAX_AUTH_TTL). */
export function gen8AuthTtlSeconds(env = process.env) {
  const n = Number(env.ROUTE_AUTH_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), MAX_AUTH_TTL_SECONDS) : 10 * 60;
}

/**
 * B scheduled open. `raw` is campaignRequest.openAt in unix seconds (a non-negative integer, as a number or a decimal
 * string). Returns 0n (trading opens at launch) when it is absent, 0 or not after `nowSec`; otherwise the time
 * itself, which must be at most nowSec + MAX_OPEN_DELAY - ttlSeconds: the launch can run up to the authorization's
 * deadline (nowSec + ttl), and the launcher refuses openAt > block time + 30 days (OpenAtTooFar), so this bound keeps
 * every launch the API signs out of that revert. Throws Gen8CreateError 400 GEN8_OPEN_AT_INVALID.
 */
export function parseGen8OpenAt(raw, { nowSec, ttlSeconds }) {
  if (raw === undefined || raw === null || raw === "") return 0n;
  let value;
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 0) value = null;
    else value = BigInt(raw);
  } else if (typeof raw === "bigint") {
    value = raw >= 0n ? raw : null;
  } else if (typeof raw === "string" && /^\d{1,20}$/.test(raw.trim())) {
    value = BigInt(raw.trim());
  } else {
    value = null;
  }
  const maxOpenAt = BigInt(Math.trunc(nowSec)) + BigInt(GEN8_MAX_OPEN_DELAY_SECONDS) - BigInt(Math.trunc(ttlSeconds));
  if (value === null) {
    throw new Gen8CreateError(400, "GEN8_OPEN_AT_INVALID", "openAt must be a whole number of unix seconds (0 or absent opens trading at launch).", { maxOpenAt: maxOpenAt.toString() });
  }
  if (value <= BigInt(Math.trunc(nowSec))) return 0n;
  if (value > maxOpenAt) {
    throw new Gen8CreateError(400, "GEN8_OPEN_AT_INVALID", "Trading can open at most 30 days after the launch.", { maxOpenAt: maxOpenAt.toString() });
  }
  return value;
}

/**
 * Normalises the request body into the launch request (without salt / minFirstBuyOut, which are chosen once the
 * launcher's plan is known). Throws Gen8CreateError (400) on a bad field. `nowSec` (default the clock) bounds openAt.
 */
export function parseGen8CreateRequest(body, chainId, env = process.env, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const source = body?.campaignRequest || body?.launchRequest || body?.request || body || {};
  const name = String(source.name || "");
  const symbol = String(source.symbol || "");
  const logoURI = String(source.logoURI || source.logoUri || "");
  if (!name.trim()) throw new Gen8CreateError(400, "GEN8_CREATE_FIELD_INVALID", "Campaign request name is required");
  if (!symbol.trim()) throw new Gen8CreateError(400, "GEN8_CREATE_FIELD_INVALID", "Campaign request symbol is required");
  if (!logoURI.trim()) throw new Gen8CreateError(400, "GEN8_CREATE_FIELD_INVALID", "Campaign request logoURI is required");
  const xAccount = String(source.xAccount || "");
  const website = String(source.website || "");
  const extraLink = String(source.extraLink || "");
  const description = String(source.description || "");
  checkGen8Text(name, "name", { maxBytes: GEN8_NAME_MAX_BYTES });
  checkGen8Text(symbol, "symbol", { maxBytes: GEN8_SYMBOL_MAX_BYTES });
  checkGen8Text(logoURI, "logoURI", { maxBytes: GEN8_URI_MAX_BYTES });
  if (!GEN8_LOGO_URI_SCHEME.test(logoURI)) throw new Gen8CreateError(400, "GEN8_CREATE_FIELD_INVALID", "logoURI must be an https:// or ipfs:// URL (http and data: are refused)");
  checkGen8Text(xAccount, "xAccount", { maxBytes: GEN8_URI_MAX_BYTES });
  checkGen8Text(website, "website", { maxBytes: GEN8_URI_MAX_BYTES });
  checkGen8Text(extraLink, "extraLink", { maxBytes: GEN8_URI_MAX_BYTES });
  checkGen8Text(description, "description", { maxLength: GEN8_DESCRIPTION_MAX_LENGTH, forbidden: GEN8_FORBIDDEN_DESCRIPTION_CHARS });

  let targetUsd = parseUintField(source.targetUsd ?? source.graduationTarget ?? source.graduationTargetWei, "graduationTarget", 0n);
  if (targetUsd === 0n) targetUsd = GEN8_TARGET_DEFAULT_USD; // no default on the launcher: $50K, its DEFAULT_GRADUATION_USD
  if (!isGen8TargetAllowed(chainId, targetUsd)) {
    throw new Gen8CreateError(400, "GEN8_TARGET_UNSUPPORTED", "Generation 8 coins graduate at a $30,000 or $50,000 market cap ($150 on testnets).");
  }
  // The $150 tier needs the same switch as gen-6/7 test tiers (route-auth.js validateGraduationTarget).
  if (targetUsd === GEN8_TARGET_TEST_USD && !isTruthy(env.VITE_ENABLE_TEST_GRADUATION_THRESHOLD || env.ENABLE_TEST_GRADUATION_THRESHOLD)) {
    throw new Gen8CreateError(400, "GEN8_TARGET_UNSUPPORTED", "The $150 test graduation target is switched off.");
  }
  const feeChoice = parseFeeChoice(source);
  const firstBuyValue = parseUintField(source.firstBuyValue ?? source.firstBuyValueWei ?? body?.firstBuyValue, "firstBuyValue", 0n);
  const minRaw = source.minFirstBuyOut ?? body?.minFirstBuyOut;
  const minFirstBuyOut = minRaw === undefined || minRaw === null || minRaw === "" ? null : parseUintField(minRaw, "minFirstBuyOut");
  let slippageBps = Number(source.firstBuySlippageBps ?? body?.firstBuySlippageBps ?? DEFAULT_FIRST_BUY_SLIPPAGE_BPS);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_FIRST_BUY_SLIPPAGE_BPS) {
    throw new Gen8CreateError(400, "GEN8_CREATE_FIELD_INVALID", `firstBuySlippageBps must be an integer from 0 to ${MAX_FIRST_BUY_SLIPPAGE_BPS}`);
  }
  // The server always commits to the record it logs (audit B-03): the hash is computed here from the same fields. A
  // client hash is optional; when sent it must equal ours, so the on-chain LaunchMetadata hash always matches the log.
  const metadataHash = gen8MetadataHash({ name, symbol, logoURI, xAccount, website, extraLink, description });
  const clientHash = String(source.metadataHash || "").trim();
  if (clientHash && !BYTES32.test(clientHash)) throw new Gen8CreateError(400, "GEN8_CREATE_FIELD_INVALID", "metadataHash must be a 0x-prefixed bytes32");
  if (clientHash && clientHash.toLowerCase() !== metadataHash) {
    throw new Gen8CreateError(400, "GEN8_METADATA_HASH_MISMATCH", "metadataHash does not match the name, symbol, links and description sent; leave it out and the server computes it.", { expected: metadataHash });
  }
  const openAt = parseGen8OpenAt(source.openAt, { nowSec, ttlSeconds: gen8AuthTtlSeconds(env) });
  return {
    fields: { name, symbol, logoURI, xAccount, website, extraLink, metadataHash, targetUsd, feeChoice: feeChoice.id, feeCreatorPct: feeChoice.pct, firstBuyValue, openAt },
    minFirstBuyOut,
    slippageBps,
    description,
  };
}

/** The launcher's state the signature depends on. Throws Gen8CreateError (409 / 503). */
export async function readGen8LauncherPreflight({ provider, cfg, targetUsd, signerAddress }) {
  let code;
  try {
    code = await provider.getCode(cfg.launcher);
  } catch (error) {
    throw new Gen8CreateError(503, "CREATE_PREFLIGHT_FAILED", String(error?.shortMessage || error?.message || error));
  }
  if (!code || code === "0x") throw new Gen8CreateError(409, "CREATE_FACTORY_CODE_MISSING", "The configured gen-8 launcher has no contract code.");
  const launcher = new ethers.Contract(cfg.launcher, GEN8_LAUNCHER_PREFLIGHT_ABI, provider);
  let createPaused;
  let createSigner;
  let hook;
  let allowed;
  try {
    [createPaused, createSigner, hook, allowed] = await Promise.all([
      launcher.createPaused(), launcher.createSigner(), launcher.hook(), launcher.isGraduationTargetAllowed(targetUsd),
    ]);
  } catch (error) {
    throw new Gen8CreateError(503, "CREATE_PREFLIGHT_FAILED", String(error?.shortMessage || error?.message || error));
  }
  if (ethers.getAddress(hook) !== ethers.getAddress(cfg.hook)) {
    throw new Gen8CreateError(409, "GEN8_HOOK_MISMATCH", "The gen-8 launcher on chain does not use the configured hook (EVM_GEN8_HOOK).");
  }
  if (createPaused) throw new Gen8CreateError(503, "CREATE_FACTORY_NOT_READY", "New generation 8 launches are paused.");
  if (ethers.getAddress(createSigner) !== ethers.getAddress(signerAddress)) {
    throw new Gen8CreateError(503, "ROUTE_AUTHORITY_MISMATCH", "Configured create signer does not match the gen-8 launcher's createSigner().");
  }
  if (!allowed) throw new Gen8CreateError(400, "GEN8_TARGET_UNSUPPORTED", "The launcher does not accept this graduation target on this chain.");
  let plan;
  try {
    const p = await launcher.plan(targetUsd);
    plan = { marketCapNative: BigInt(p.mc ?? p[0]), virtualNative: BigInt(p.vN ?? p[1]), virtualToken: BigInt(p.vT ?? p[2]), tickStart: Number(p.tickStart ?? p[3]), tickGrad: Number(p.tickGrad ?? p[4]) };
  } catch (error) {
    // OraclePriceUnavailable / OraclePriceOutOfBand / TargetOutOfRangeAtPrice: the launch would revert now.
    throw new Gen8CreateError(503, "GEN8_ORACLE_UNAVAILABLE", "The graduation oracle cannot size a launch right now. Try again shortly.", { reason: String(error?.shortMessage || error?.reason || error?.message || error), revert: gen8RevertReason(error)?.name ?? null });
  }
  return { createPaused: false, createSigner: ethers.getAddress(createSigner), hook: ethers.getAddress(hook), plan };
}

/** First buy: the estimate from the plan and the slippage bound the signature carries. Throws on > 70%. */
export function planGen8FirstBuy({ firstBuyValue, minFirstBuyOut, slippageBps, plan }) {
  const est = gen8FirstBuyEstimate({ valueWei: firstBuyValue, tickStart: plan.tickStart, tickGrad: plan.tickGrad });
  if (firstBuyValue > 0n && est.overCap) {
    throw new Gen8CreateError(400, "GEN8_FIRST_BUY_TOO_LARGE", "The first buy can take at most 70% of the supply (700,000,000 coins).", {
      expectedCoinsOut: est.coinsOut.toString(), maxCoins: GEN8_FIRST_BUY_MAX.toString(),
    });
  }
  let minOut = minFirstBuyOut;
  if (minOut === null) minOut = firstBuyValue > 0n ? (est.coinsOut * BigInt(10_000 - slippageBps)) / 10_000n : 0n;
  if (minOut > est.coinsOut) {
    throw new Gen8CreateError(400, "GEN8_FIRST_BUY_MIN_OUT_TOO_HIGH", "minFirstBuyOut is above what the first buy returns at today's price.", { expectedCoinsOut: est.coinsOut.toString() });
  }
  return {
    valueWei: firstBuyValue,
    curveCostWei: est.costWei,
    feeWei: est.feeWei,
    expectedCoinsOut: est.coinsOut,
    minCoinsOut: minOut,
    slippageBps: minFirstBuyOut === null ? slippageBps : null,
  };
}

/**
 * MwzBarkLauncher's state the signature depends on (Barkswap venue). Same refusals as readGen8LauncherPreflight; the
 * launcher must use the configured plugin (EVM_GEN8_PLUGIN), and its wNative() is the bound the coin must sort below.
 * Throws Gen8CreateError (409 / 503 / 400).
 */
export async function readBarkLauncherPreflight({ provider, cfg, targetUsd, signerAddress }) {
  let code;
  try {
    code = await provider.getCode(cfg.launcher);
  } catch (error) {
    throw new Gen8CreateError(503, "CREATE_PREFLIGHT_FAILED", String(error?.shortMessage || error?.message || error));
  }
  if (!code || code === "0x") throw new Gen8CreateError(409, "CREATE_FACTORY_CODE_MISSING", "The configured gen-8 launcher has no contract code.");
  const launcher = new ethers.Contract(cfg.launcher, BARK_LAUNCHER_ABI, provider);
  let createPaused;
  let createSigner;
  let plugin;
  let wNative;
  let allowed;
  try {
    [createPaused, createSigner, plugin, wNative, allowed] = await Promise.all([
      launcher.createPaused(), launcher.createSigner(), launcher.plugin(), launcher.wNative(), launcher.isGraduationTargetAllowed(targetUsd),
    ]);
  } catch (error) {
    throw new Gen8CreateError(503, "CREATE_PREFLIGHT_FAILED", String(error?.shortMessage || error?.message || error));
  }
  if (ethers.getAddress(plugin) !== ethers.getAddress(cfg.plugin)) {
    throw new Gen8CreateError(409, "GEN8_PLUGIN_MISMATCH", "The gen-8 launcher on chain does not use the configured plugin (EVM_GEN8_PLUGIN).");
  }
  if (createPaused) throw new Gen8CreateError(503, "CREATE_FACTORY_NOT_READY", "New generation 8 launches are paused.");
  if (ethers.getAddress(createSigner) !== ethers.getAddress(signerAddress)) {
    throw new Gen8CreateError(503, "ROUTE_AUTHORITY_MISMATCH", "Configured create signer does not match the gen-8 launcher's createSigner().");
  }
  if (!allowed) throw new Gen8CreateError(400, "GEN8_TARGET_UNSUPPORTED", "The launcher does not accept this graduation target on this chain.");
  let plan;
  try {
    const p = await launcher.plan(targetUsd);
    plan = {
      marketCapNative: BigInt(p.mc ?? p[0]),
      virtualNative: BigInt(p.vN ?? p[1]),
      virtualToken: BigInt(p.vT ?? p[2]),
      tickStart: Number(p.tickStart ?? p[3]),
      tickGrad: Number(p.tickGrad ?? p[4]),
      liqA: BigInt(p.liqA ?? p[5]),
      liqB: BigInt(p.liqB ?? p[6]),
    };
  } catch (error) {
    // OraclePriceUnavailable / OraclePriceOutOfBand / TargetOutOfRangeAtPrice / BadTicks: the launch would revert now.
    throw new Gen8CreateError(503, "GEN8_ORACLE_UNAVAILABLE", "The graduation oracle cannot size a launch right now. Try again shortly.", { reason: String(error?.shortMessage || error?.reason || error?.message || error), revert: gen8RevertReason(error)?.name ?? null });
  }
  return { createPaused: false, createSigner: ethers.getAddress(createSigner), plugin: ethers.getAddress(plugin), wNative: ethers.getAddress(wNative), plan };
}

/** Barkswap first buy: the Algebra estimate (shared/evmGen8Bark.mjs) and the slippage bound. Same refusals as V4. */
export function planBarkFirstBuy({ firstBuyValue, minFirstBuyOut, slippageBps, plan }) {
  const est = barkFirstBuyEstimate({ valueWei: firstBuyValue, tickStart: plan.tickStart, tickGrad: plan.tickGrad, liqA: plan.liqA });
  if (firstBuyValue > 0n && est.overCap) {
    throw new Gen8CreateError(400, "GEN8_FIRST_BUY_TOO_LARGE", "The first buy can take at most 70% of the supply (700,000,000 coins).", {
      expectedCoinsOut: est.coinsOut.toString(), maxCoins: GEN8_FIRST_BUY_MAX.toString(),
    });
  }
  let minOut = minFirstBuyOut;
  if (minOut === null) minOut = firstBuyValue > 0n ? (est.coinsOut * BigInt(10_000 - slippageBps)) / 10_000n : 0n;
  if (minOut > est.coinsOut) {
    throw new Gen8CreateError(400, "GEN8_FIRST_BUY_MIN_OUT_TOO_HIGH", "minFirstBuyOut is above what the first buy returns at today's price.", { expectedCoinsOut: est.coinsOut.toString() });
  }
  return {
    valueWei: firstBuyValue,
    curveCostWei: est.costWei,
    feeWei: est.feeWei,
    expectedCoinsOut: est.coinsOut,
    minCoinsOut: minOut,
    slippageBps: minFirstBuyOut === null ? slippageBps : null,
    algebraFeeUnits: est.feeUnits,
  };
}

/** The Bark salt search; a Gen8CreateError (503) when no salt sorts the coin below wNative. */
function barkSaltFor({ cfg, creator, fields, wNative, randomSalt }) {
  try {
    return findBarkCoinSalt({ launcher: cfg.launcher, creator, name: fields.name, symbol: fields.symbol, wNative, ...(randomSalt ? { randomSalt } : {}) });
  } catch (error) {
    if (error?.code === "GEN8_SALT_NOT_FOUND") throw new Gen8CreateError(503, "GEN8_SALT_NOT_FOUND", "No coin address below the launcher's wrapped native token was found. Try again.");
    throw error;
  }
}

/** Signs the launch request for `creator`. Returns { payload, signature } and checks the signature recovers. */
export async function signGen8CreateAuthorization({ signer, chainId, launcher, creator, request, deadline }) {
  const payload = gen8AuthorizationPayload({ chainId, launcher, creator, request, deadline });
  const signature = await signer.signMessage(ethers.getBytes(payload));
  if (ethers.verifyMessage(ethers.getBytes(payload), signature) !== signer.address) throw new Error("gen-8 create signature does not recover to the signer");
  return { payload, digest: ethers.hashMessage(ethers.getBytes(payload)), signature };
}

function authDeadline(env, nowSec) {
  return nowSec + gen8AuthTtlSeconds(env);
}

/**
 * The whole create authorization. deps (all injectable for tests):
 *   signer, getProvider(chainId), evaluateCreatePreflight({walletAddress, chainId}), getRouteDecision(wallet),
 *   logRouteAuthorization(row), canaryAllows(wallet) (default: CREATE_CANARY_WALLETS in env), canaryRefusal(), env,
 *   now() (ms), randomSalt()
 * Returns { status, body }.
 */
export async function gen8CreateAuthorization(body, deps) {
  const env = deps.env || process.env;
  const chainId = Number(body?.chainId);
  const cfg = gen8ConfigFor(chainId, env);
  if (!cfg) return { status: 400, body: { error: "Generation 8 launches are not configured on this chain.", code: "GEN8_NOT_CONFIGURED" } };
  const bark = isGen8BarkConfig(cfg);
  const signer = deps.signer;
  if (!signer) {
    return { status: 503, body: { error: "Create authorization signer is not configured.", code: "ROUTE_AUTHORIZER_NOT_CONFIGURED", requiredEnv: ["EVM_GEN8_CREATE_SIGNER_PRIVATE_KEY", "or ROUTE_AUTHORITY_PRIVATE_KEY"] } };
  }
  // Strict 0x form only (audit B-02): bare hex and ICAP are refused here too, so no caller can reach the signer
  // with a wallet form that an earlier check did not see.
  const wallet = strictEvmWallet(body?.walletAddress);
  if (!wallet.ok) return { status: 400, body: { error: "Invalid or missing walletAddress", code: "GEN8_WALLET_INVALID" } };
  const walletAddress = wallet.address;
  const requestedLauncher = String(body?.launcherAddress || body?.factoryAddress || "").trim();
  if (requestedLauncher && (!ethers.isAddress(requestedLauncher) || ethers.getAddress(requestedLauncher) !== cfg.launcher)) {
    return { status: 400, body: { error: "launcherAddress is not this chain's gen-8 launcher.", code: "GEN8_LAUNCHER_MISMATCH", launcher: cfg.launcher } };
  }
  // The go-live canary runs here as well as in route-auth.js (defence in depth). Without an injected check it reads
  // CREATE_CANARY_WALLETS from env, so a direct caller cannot skip it by leaving the dependency out.
  const canaryAllows = deps.canaryAllows || ((w) => isCreateAllowedForWallet(w, env));
  if (!canaryAllows(walletAddress)) return { status: 403, body: deps.canaryRefusal ? deps.canaryRefusal() : createCanaryRefusalBody() };
  if (body?.stockToken || body?.graduationQuoteAsset || body?.graduationQuoteAssetId || body?.quoteAssetId) {
    // D12: quote-bound coins (BNB quote tokens, Robinhood stocks) stay on gen-7.
    return { status: 400, body: { error: "Quote-bound coins launch on generation 7; generation 8 is native only.", code: "GEN8_NATIVE_ONLY" } };
  }

  try {
    const nowSec = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
    const parsed = parseGen8CreateRequest(body, chainId, env, { nowSec });
    const createPreflight = await deps.evaluateCreatePreflight({ walletAddress, chainId });
    if (!createPreflight?.allowed) {
      return { status: 403, body: { error: createPreflight?.reasons?.[0] || "Wallet is not eligible to launch.", code: "CREATE_PREFLIGHT_BLOCKED", preflight: createPreflight } };
    }
    const provider = await deps.getProvider(chainId);
    if (!provider) return { status: 503, body: { error: "RPC URL is missing for this chain.", code: "CREATE_RPC_NOT_CONFIGURED" } };
    const onChain = await (bark ? readBarkLauncherPreflight : readGen8LauncherPreflight)({ provider, cfg, targetUsd: parsed.fields.targetUsd, signerAddress: signer.address });
    const firstBuy = (bark ? planBarkFirstBuy : planGen8FirstBuy)({ firstBuyValue: parsed.fields.firstBuyValue, minFirstBuyOut: parsed.minFirstBuyOut, slippageBps: parsed.slippageBps, plan: onChain.plan });
    // Barkswap: a salt whose CREATE2 coin sorts below the launcher's wNative (launch() refuses any other).
    const barkCoin = bark ? barkSaltFor({ cfg, creator: walletAddress, fields: parsed.fields, wNative: onChain.wNative, randomSalt: deps.randomSalt }) : null;
    const salt = bark ? barkCoin.salt : deps.randomSalt ? BigInt(deps.randomSalt()) : BigInt(`0x${crypto.randomBytes(32).toString("hex")}`);
    const request = { ...parsed.fields, minFirstBuyOut: firstBuy.minCoinsOut, salt };
    const deadline = authDeadline(env, nowSec);
    const signed = await signGen8CreateAuthorization({ signer, chainId, launcher: cfg.launcher, creator: walletAddress, request, deadline });
    const validUntil = new Date(deadline * 1000).toISOString();

    const route = await deps.getRouteDecision(walletAddress);
    // Founder 2026-10-11: on gen-8 a wallet that owns a recruiter row but has no link is unlinked (the indexer's
    // fee attribution rule). The profile here is informational only; the indexer attributes every gen-8 fee itself.
    const selfRecruiter = route?.decision?.recruiterLinkState === "self_recruiter_wallet";
    const routeProfileId = selfRecruiter ? 1 : Number(route?.tradeRouteProfileId ?? 1);
    const finalizeRouteProfileId = selfRecruiter ? 1 : Number(route?.finalizeRouteProfileId ?? 1);
    const launchRequest = gen8LaunchRequestJson(request);
    const generation = { factoryGeneration: EVM_GEN8_FACTORY_GENERATION, campaignGeneration: EVM_GEN8_CAMPAIGN_GENERATION, requestHashLayout: "gen8_14_field", kind: "gen8", ...(bark ? { venue: cfg.venue } : {}) };
    // B: when trading opens (unix seconds; 0 = at launch, the launch block time). The launch request carries it last.
    const openAtJson = { openAt: Number(request.openAt), scheduled: request.openAt > 0n, maxOpenDelaySeconds: GEN8_MAX_OPEN_DELAY_SECONDS };
    const planJson = {
      targetUsd: parsed.fields.targetUsd.toString(),
      marketCapNative: onChain.plan.marketCapNative.toString(),
      virtualNative: onChain.plan.virtualNative.toString(),
      virtualToken: onChain.plan.virtualToken.toString(),
      tickStart: onChain.plan.tickStart,
      tickGrad: onChain.plan.tickGrad,
      ...(bark ? { liqA: onChain.plan.liqA.toString(), liqB: onChain.plan.liqB.toString() } : {}),
    };
    const firstBuyJson = {
      valueWei: firstBuy.valueWei.toString(),
      curveCostWei: firstBuy.curveCostWei.toString(),
      feeWei: firstBuy.feeWei.toString(),
      expectedCoinsOut: firstBuy.expectedCoinsOut.toString(),
      minCoinsOut: firstBuy.minCoinsOut.toString(),
      slippageBps: firstBuy.slippageBps,
      feeBps: 200,
      ...(bark ? { algebraFeeUnits: firstBuy.algebraFeeUnits, estimate: "algebra_one_step" } : {}),
    };
    const preflight = bark
      ? { ...createPreflight, launcher: cfg.launcher, createPaused: false, createSigner: onChain.createSigner, plugin: onChain.plugin, wNative: onChain.wNative }
      : { ...createPreflight, launcher: cfg.launcher, createPaused: false, createSigner: onChain.createSigner, hook: onChain.hook };
    // Barkswap: the coin's address is fixed by the creator, the salt, the name and the symbol (MwzBarkLaunchLib.deployCoin).
    const coinJson = bark ? { address: barkCoin.coin, wNative: onChain.wNative, sortsBelowWNative: true, saltTries: barkCoin.tries } : null;
    await deps.logRouteAuthorization({
      chainId,
      walletAddress,
      routeKind: "create",
      routeProfileId,
      finalizeRouteProfileId,
      factoryAddress: cfg.launcher,
      decision: route?.decision || null,
      routeAuthority: signer.address,
      authorizationDeadline: deadline,
      validUntil,
      metadata: {
        endpoint: "/api/routing/create-authorization",
        generation,
        launchRequest,
        requestHash: gen8HashRequest(request),
        digest: signed.digest,
        plan: planJson,
        firstBuy: firstBuyJson,
        feeChoice: { id: request.feeChoice, name: GEN8_FEE_CHOICE_NAMES[request.feeChoice], creatorPct: request.feeCreatorPct || null },
        trading: openAtJson,
        description: parsed.description || null,
        preflight,
        ...(bark ? { coin: coinJson } : {}),
      },
    });

    if (bark) {
      return {
        status: 200,
        body: {
          // launcher.launch(launchRequest, { deadline, signature }, { value: launchRequest.firstBuyValue })
          authorization: { deadline, signature: signed.signature, validUntil, digest: signed.digest },
          launchRequest,
          venue: cfg.venue,
          launcher: cfg.launcher,
          plugin: cfg.plugin,
          hook: null,
          chainId,
          generation,
          plan: planJson,
          firstBuy: firstBuyJson,
          feeChoice: { id: request.feeChoice, name: GEN8_FEE_CHOICE_NAMES[request.feeChoice], creatorPct: request.feeCreatorPct || null },
          trading: openAtJson,
          coin: coinJson,
          graduationMarket: { kind: "NATIVE", quoteAsset: null, venue: "barkswap_algebra_plugin" },
          tradePath: GEN8_TRADE_PATH,
          routeAuthority: signer.address,
          decision: route?.decision || null,
          preflight,
        },
      };
    }
    return {
      status: 200,
      body: {
        // launcher.launch(launchRequest, { deadline, signature }, { value: launchRequest.firstBuyValue })
        authorization: { deadline, signature: signed.signature, validUntil, digest: signed.digest },
        launchRequest,
        launcher: cfg.launcher,
        hook: cfg.hook,
        chainId,
        generation,
        plan: planJson,
        firstBuy: firstBuyJson,
        feeChoice: { id: request.feeChoice, name: GEN8_FEE_CHOICE_NAMES[request.feeChoice], creatorPct: request.feeCreatorPct || null },
        trading: openAtJson,
        graduationMarket: { kind: "NATIVE", quoteAsset: null, venue: "uniswap_v4_hook" },
        tradePath: GEN8_TRADE_PATH,
        routeAuthority: signer.address,
        decision: route?.decision || null,
        preflight,
      },
    };
  } catch (error) {
    if (error instanceof Gen8CreateError) {
      return { status: error.httpStatus, body: { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) } };
    }
    throw error;
  }
}

/**
 * GET /api/routing/status for the gen-8 launcher (factoryAddress = the chain's EVM_GEN8_LAUNCHER): whether a create
 * authorization can be issued now. Same top-level fields as the gen-7 status where they apply.
 */
export async function gen8RoutingStatus({ chainId, signer, getProvider, env = process.env }) {
  const cfg = gen8ConfigFor(chainId, env);
  if (!cfg) return { ok: false, status: "gen8_not_configured", chainId };
  if (isGen8BarkConfig(cfg)) return barkRoutingStatus({ cfg, chainId, signer, getProvider, env });
  const warnings = [];
  let onChain = null;
  const provider = await getProvider(chainId).catch(() => null);
  if (!signer) warnings.push("Create signer is not configured.");
  if (!provider) warnings.push("RPC URL is not configured.");
  if (provider) {
    try {
      const launcher = new ethers.Contract(cfg.launcher, GEN8_LAUNCHER_PREFLIGHT_ABI, provider);
      const [createPaused, createSigner, hook] = await Promise.all([launcher.createPaused(), launcher.createSigner(), launcher.hook()]);
      onChain = { createPaused: Boolean(createPaused), createSigner: ethers.getAddress(createSigner), hook: ethers.getAddress(hook) };
      if (onChain.createPaused) warnings.push("Generation 8 launches are paused.");
      if (signer && onChain.createSigner !== signer.address) warnings.push("Configured create signer does not match the launcher's createSigner().");
      if (onChain.hook !== cfg.hook) warnings.push("The launcher does not use the configured hook.");
    } catch (error) {
      warnings.push(String(error?.shortMessage || error?.message || error));
    }
  }
  const matchesOnchain = Boolean(signer && onChain && onChain.createSigner === signer.address);
  const ready = Boolean(matchesOnchain && onChain && !onChain.createPaused && onChain.hook === cfg.hook);
  return {
    ok: ready,
    readyForCoreFlow: ready,
    status: !signer ? "route_signer_missing" : !provider ? "rpc_missing" : !onChain ? "onchain_unreadable" : !matchesOnchain ? "route_authority_mismatch" : onChain.createPaused ? "create_paused" : ready ? "ready" : "hook_mismatch",
    warnings,
    chainId,
    generation: { factoryGeneration: EVM_GEN8_FACTORY_GENERATION, kind: "gen8" },
    factoryAddress: cfg.launcher,
    launcher: cfg.launcher,
    hook: cfg.hook,
    lens: cfg.lens,
    poolManager: cfg.poolManager,
    signerConfigured: Boolean(signer),
    routeAuthority: signer?.address || null,
    onchainRouteAuthority: onChain?.createSigner || null,
    matchesOnchain,
    createPaused: onChain ? onChain.createPaused : null,
    tradeAuthorization: "none",
    tradePath: GEN8_TRADE_PATH,
    ttlSeconds: gen8AuthTtlSeconds(env),
  };
}

/** gen8RoutingStatus on the Barkswap venue: MwzBarkLauncher's createSigner, pause and plugin (it has no hook). */
async function barkRoutingStatus({ cfg, chainId, signer, getProvider, env }) {
  const warnings = [];
  let onChain = null;
  const provider = await getProvider(chainId).catch(() => null);
  if (!signer) warnings.push("Create signer is not configured.");
  if (!provider) warnings.push("RPC URL is not configured.");
  if (provider) {
    try {
      const launcher = new ethers.Contract(cfg.launcher, BARK_LAUNCHER_ABI, provider);
      const [createPaused, createSigner, plugin] = await Promise.all([launcher.createPaused(), launcher.createSigner(), launcher.plugin()]);
      onChain = { createPaused: Boolean(createPaused), createSigner: ethers.getAddress(createSigner), plugin: ethers.getAddress(plugin) };
      if (onChain.createPaused) warnings.push("Generation 8 launches are paused.");
      if (signer && onChain.createSigner !== signer.address) warnings.push("Configured create signer does not match the launcher's createSigner().");
      if (onChain.plugin !== cfg.plugin) warnings.push("The launcher does not use the configured plugin.");
    } catch (error) {
      warnings.push(String(error?.shortMessage || error?.message || error));
    }
  }
  const matchesOnchain = Boolean(signer && onChain && onChain.createSigner === signer.address);
  const ready = Boolean(matchesOnchain && onChain && !onChain.createPaused && onChain.plugin === cfg.plugin);
  return {
    ok: ready,
    readyForCoreFlow: ready,
    status: !signer ? "route_signer_missing" : !provider ? "rpc_missing" : !onChain ? "onchain_unreadable" : !matchesOnchain ? "route_authority_mismatch" : onChain.createPaused ? "create_paused" : ready ? "ready" : "plugin_mismatch",
    warnings,
    chainId,
    venue: cfg.venue,
    generation: { factoryGeneration: EVM_GEN8_FACTORY_GENERATION, kind: "gen8", venue: cfg.venue },
    factoryAddress: cfg.launcher,
    launcher: cfg.launcher,
    plugin: cfg.plugin,
    hook: null,
    lens: cfg.lens,
    poolManager: null,
    signerConfigured: Boolean(signer),
    routeAuthority: signer?.address || null,
    onchainRouteAuthority: onChain?.createSigner || null,
    matchesOnchain,
    createPaused: onChain ? onChain.createPaused : null,
    tradeAuthorization: "none",
    tradePath: GEN8_TRADE_PATH,
    ttlSeconds: gen8AuthTtlSeconds(env),
  };
}
