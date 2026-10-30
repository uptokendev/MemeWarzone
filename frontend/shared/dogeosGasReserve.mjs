/**
 * DogeOS: the DOGE a buy or a launch keeps back for network fees (barkswap plan t34, founder decision A 2026-10-17).
 *
 * Every DogeOS transaction pays L2 gas (cheap) plus an L1 data fee that the L1GasPriceOracle predeploy prices from
 * the transaction's bytes (`getL1Fee(bytes)`). That fee follows Ethereum's base and blob fees and swings a lot: the
 * t27 rehearsal (reports/dogeos/bark-fork-rehearsal.json) measured a 440-byte buy at 0.039 DOGE on 2026-10-15 and
 * 0.90 DOGE at the 2026-10-14 oracle; a 1,239-byte launch at 0.119 and 2.74. So the reserve is read live:
 *
 *   reserve = max(floor, (getL1Fee(representative raw tx + margin) + gasLimit x gasPrice) x 1.5)
 *
 * with the floor when the read fails. Pure and dependency-free: the app (src/lib/dogeosGasReserve.ts) and the fork
 * rehearsal (scripts/lib/dogeosBarkBudget.mjs, scripts/rehearse-dogeos-bark-fork.ts) use the same numbers.
 *
 * A DogeOS mainnet only needs its chain id in DOGEOS_L1_FEE_ORACLES (and in chainConfig's isDogeosChainId).
 * Amounts are bigint wei (DOGE, 18 decimals).
 */

/** Scroll-style L1GasPriceOracle predeploy on DogeOS. */
export const DOGEOS_L1_GAS_PRICE_ORACLE = "0x5300000000000000000000000000000000000002";

/** The DogeOS chains with an L1 data fee, and their oracle: Chikyū testnet. */
export const DOGEOS_L1_FEE_ORACLES = Object.freeze({ 6281971: DOGEOS_L1_GAS_PRICE_ORACLE });

/** The oracle for `chainId`, or null when the chain is not a DogeOS chain with an L1 data fee. */
export function dogeosL1OracleFor(chainId) {
  if (typeof chainId !== "number" && typeof chainId !== "bigint") return null;
  return Object.prototype.hasOwnProperty.call(DOGEOS_L1_FEE_ORACLES, String(chainId)) ? DOGEOS_L1_FEE_ORACLES[String(chainId)] : null;
}

/** What a DogeOS buy / launch always keeps back, and what is kept back when the live read fails. */
export const DOGE_BUY_RESERVE_FLOOR_WEI = 50_000_000_000_000_000n; // 0.05 DOGE
export const DOGE_LAUNCH_RESERVE_FLOOR_WEI = 200_000_000_000_000_000n; // 0.2 DOGE

/** The live estimate is multiplied by this (percent) before it is compared with the floor. */
export const DOGEOS_RESERVE_MARGIN_PCT = 150;
/** How long one live estimate is reused (per chain, kind, size and gas limit). */
export const DOGEOS_RESERVE_CACHE_MS = 30_000;

/**
 * The gas limits the node checks the balance against (gasLimit x gasPrice up front). A buy: BARK_TRADE_GAS_FLOOR
 * (frontend/src/lib/evmGen8Client.mjs), which binds (rehearsal: dearest buy 397,337 gas, app limit 1,000,000). A launch:
 * the rehearsal's dearest launch got an app limit of 7,915,397 (6,292,318 x 1.25 + 50,000).
 */
export const DOGEOS_BUY_GAS_LIMIT = 1_000_000n;
export const DOGEOS_LAUNCH_GAS_LIMIT = 8_000_000n;

/** The rehearsal's dearest buy as a raw legacy (type 0) transaction: the graduating buy, 376 bytes. */
export const DOGEOS_BUY_RAW_TX_BYTES = 376;

/**
 * A legacy DogeOS transaction's bytes besides its calldata, at most: RLP headers, nonce, gas price, gas limit, to,
 * value, v (chain id 6281971) and a full-length r and s. The rehearsal's launch measured 115.
 */
export const LEGACY_TX_ENVELOPE_BYTES = 128;

/** The rehearsal's launch strings (test/dogeos/barkswap/fixtures/barkswap.ts launchRequest): a launch of 1,175 raw bytes. */
export const DOGEOS_REPRESENTATIVE_LAUNCH_STRINGS = Object.freeze({
  name: "Bark Test Coin",
  symbol: "BARK",
  logoURI: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  xAccount: "",
  website: "",
  extraLink: "",
});
const LAUNCH_STRING_FIELDS = Object.freeze(["name", "symbol", "logoURI", "xAccount", "website", "extraLink"]);

const utf8Length = (s) => new TextEncoder().encode(String(s ?? "")).length;
const abiDynamicBytes = (len) => 32 + Math.ceil(len / 32) * 32;

/**
 * Byte length of MwzBarkLauncher.launch(req, auth) calldata (frontend/src/lib/barkswapSwap.mjs BARK_LAUNCHER_APP_ABI) for
 * these strings: selector, two tuple offsets, the request's 14 head words and its six string tails, then the
 * authorization's two head words and its 65-byte signature. A field left out takes the rehearsal's string.
 */
export function barkLaunchCalldataBytes(strings = {}) {
  let tails = 0;
  for (const f of LAUNCH_STRING_FIELDS) tails += abiDynamicBytes(utf8Length(strings[f] ?? DOGEOS_REPRESENTATIVE_LAUNCH_STRINGS[f]));
  return 4 + 2 * 32 + 14 * 32 + tails + 2 * 32 + abiDynamicBytes(65);
}

function assertKind(kind) {
  if (kind !== "buy" && kind !== "launch") throw new Error(`DogeOS gas reserve: kind must be buy or launch (got ${kind})`);
}

/** The floor for a buy or a launch. */
export function dogeosReserveFloorWei(kind) {
  assertKind(kind);
  return kind === "buy" ? DOGE_BUY_RESERVE_FLOOR_WEI : DOGE_LAUNCH_RESERVE_FLOOR_WEI;
}

/** Raw transaction bytes to price: a buy's measured size; a launch's calldata (given, else the rehearsal's) + envelope. */
export function dogeosReserveRawTxBytes({ kind, calldataBytes = null }) {
  assertKind(kind);
  if (kind === "buy") return DOGEOS_BUY_RAW_TX_BYTES;
  const data = calldataBytes == null ? barkLaunchCalldataBytes() : calldataBytes;
  if (!Number.isSafeInteger(data) || data < 0) throw new RangeError(`bad launch calldata length ${calldataBytes}`);
  return data + LEGACY_TX_ENVELOPE_BYTES;
}

/**
 * Margin added to a transaction's raw bytes before getL1Fee: at least 64 bytes, or 5% of the raw length when that is
 * more. The priced transaction differs from the real one (nonce, fee fields, signature, user strings).
 */
export const L1_MARGIN = Object.freeze({ minBytes: 64, pct: 5 });

/** Bytes of margin for a raw transaction of `len` bytes. */
export function l1MarginBytes(len, margin = L1_MARGIN) {
  if (!Number.isSafeInteger(len) || len < 0) throw new RangeError(`bad raw length ${len}`);
  return Math.max(margin.minBytes, Math.ceil((len * margin.pct) / 100));
}

/** `n` deterministic xorshift bytes as hex (no 0x), never a zero byte. */
function fillerHex(n, seed) {
  let x = seed;
  let out = "";
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    const b = (x & 0xff) || 0x5a;
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

const WHOLE_BYTE_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * `rawHex` with the margin appended. The filler is deterministic and incompressible-looking (xorshift bytes, never
 * zero): Chikyū's oracle prices by size and compressibility, so the filler must not be a cheap pattern.
 */
export function paddedForL1(rawHex, margin = L1_MARGIN) {
  if (typeof rawHex !== "string" || !WHOLE_BYTE_HEX.test(rawHex)) throw new TypeError("rawHex must be 0x-prefixed whole-byte hex");
  const len = (rawHex.length - 2) / 2;
  return rawHex + fillerHex(l1MarginBytes(len, margin), 0x9e3779b9 ^ len);
}

/**
 * A payload of `rawTxBytes` bytes plus the margin, all non-zero pseudo-random bytes. Before signing the app has no
 * raw transaction, so it prices one of the same size; random bytes are the dearest shape of a given size (measured
 * 2026-10-17 on Chikyū: a real legacy buy and random bytes of its length price the same).
 */
export function representativeL1Payload(rawTxBytes) {
  if (!Number.isSafeInteger(rawTxBytes) || rawTxBytes < 0) throw new RangeError(`bad raw length ${rawTxBytes}`);
  return paddedForL1(`0x${fillerHex(rawTxBytes, 0x2545f491 ^ rawTxBytes)}`);
}

/** eth_call data for getL1Fee(bytes) (selector 0x49948e0e) with `payloadHex`. */
export function encodeGetL1FeeCall(payloadHex) {
  if (typeof payloadHex !== "string" || !WHOLE_BYTE_HEX.test(payloadHex)) throw new TypeError("payload must be 0x-prefixed whole-byte hex");
  const body = payloadHex.slice(2).toLowerCase();
  const len = body.length / 2;
  const word = (n) => n.toString(16).padStart(64, "0");
  const padded = body + "0".repeat((64 - (body.length % 64)) % 64);
  return `0x49948e0e${word(32)}${word(len)}${padded}`;
}

function assertWei(name, v) {
  if (typeof v !== "bigint" || v < 0n) throw new TypeError(`${name} must be a non-negative bigint`);
}

/** max(floor, (l1Fee + gasLimit x gasPrice) x margin), rounded up to the wei. */
export function dogeosReserveFromFees({ kind, l1FeeWei, gasLimit, gasPriceWei }) {
  const floor = dogeosReserveFloorWei(kind);
  assertWei("l1FeeWei", l1FeeWei);
  assertWei("gasLimit", gasLimit);
  assertWei("gasPriceWei", gasPriceWei);
  const pct = BigInt(DOGEOS_RESERVE_MARGIN_PCT);
  const live = ((l1FeeWei + gasLimit * gasPriceWei) * pct + 99n) / 100n;
  return live > floor ? live : floor;
}

/** A cache of live estimates: successful reads only, reused for `ttlMs`; one read in flight per key. */
export function createDogeosReserveCache({ ttlMs = DOGEOS_RESERVE_CACHE_MS, now = () => Date.now() } = {}) {
  return { ttlMs, now, done: new Map(), inFlight: new Map() };
}
const defaultCache = createDogeosReserveCache();

function quantity(v, what) {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error(`${what}: not a hex quantity`);
  return BigInt(v);
}

/**
 * The live reserve for a DogeOS buy or launch, read on `provider` (an ethers JsonRpcProvider: the chain's read
 * provider, as the trade path uses): getL1Fee for a representative payload by eth_call, and eth_gasPrice (DogeOS
 * sends legacy at that price). Any failed or malformed read returns the floor (reported to `onError`, not cached).
 * Throws only for a chain without a DogeOS oracle or a bad kind, before any read.
 */
export async function estimateDogeosReserveWei({ provider, chainId, kind, gasLimit = null, calldataBytes = null, cache = defaultCache, onError = null }) {
  const oracle = dogeosL1OracleFor(chainId);
  if (!oracle) throw new Error(`DogeOS gas reserve: chain ${chainId} is not a DogeOS chain`);
  const floor = dogeosReserveFloorWei(kind);
  const limit = gasLimit == null ? (kind === "buy" ? DOGEOS_BUY_GAS_LIMIT : DOGEOS_LAUNCH_GAS_LIMIT) : BigInt(gasLimit);
  const rawTxBytes = dogeosReserveRawTxBytes({ kind, calldataBytes });
  if (!provider || typeof provider.send !== "function") return floor;
  const key = `${chainId}:${kind}:${rawTxBytes}:${limit}`;
  const hit = cache.done.get(key);
  if (hit && cache.now() - hit.at < cache.ttlMs) return hit.wei;
  if (!cache.inFlight.has(key)) {
    const data = encodeGetL1FeeCall(representativeL1Payload(rawTxBytes));
    const read = Promise.all([provider.send("eth_call", [{ to: oracle, data }, "latest"]), provider.send("eth_gasPrice", [])])
      .then(([l1, price]) => {
        const wei = dogeosReserveFromFees({ kind, l1FeeWei: quantity(l1, "getL1Fee"), gasLimit: limit, gasPriceWei: quantity(price, "eth_gasPrice") });
        cache.done.set(key, { at: cache.now(), wei });
        return wei;
      })
      .finally(() => cache.inFlight.delete(key));
    cache.inFlight.set(key, read);
  }
  try {
    return await cache.inFlight.get(key);
  } catch (error) {
    onError?.(error);
    return floor;
  }
}

/** A reserve as DOGE for a message: rounded up to 0.01, trailing zeros dropped ("0.06", "0.2", "2"). */
export function formatDogeReserve(wei) {
  assertWei("wei", wei);
  const cents = (wei + 10n ** 16n - 1n) / 10n ** 16n;
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
