/**
 * Live native/USD price for boost and sponsorship quotes, all three chains.
 *
 * The API is the only price oracle for these quotes: ArenaWarPoolTreasuryV2,
 * WarzoneSponsorshipRouterV1 and the Solana money-v2 program verify the
 * signature and the deadline, never the price. Until 2026-09-24 the price came
 * only from a static env snapshot (`*_NATIVE_USD_MICROS`, `*_NATIVE_USD_UPDATED_AT`)
 * with a 300 s max age, and nothing refreshed it, so on a live API every quote
 * failed five minutes after the redeploy.
 *
 * This reads the spot readers that already price UP votes, the league and the
 * recruiter (Binance spot, in-process cache, env override first) and reports
 * WHEN the price was observed. The sync pricing readers then apply their
 * existing max-age rule to that observation, not to the moment of signing: a
 * reader that falls back to an old cache during an exchange outage is refused
 * and no quote is signed. No price at all -> throw; the route answers 503.
 *
 * A pinned env snapshot still wins (see hasPinnedNativeUsd): setting
 * `*_NATIVE_USD_MICROS` means the operator takes over the price and its
 * timestamp, exactly as before this module existed.
 */
import { resolveBnbUsdPrice } from "./bnbUsdPrice.js";
import { resolveEthUsdPrice } from "./ethUsdPrice.js";
import { resolveSolUsdPrice } from "./solUsdPrice.js";

export const NATIVE_ASSET_BY_CHAIN = Object.freeze({ 56: "BNB", 97: "BNB", 4663: "ETH", 46630: "ETH", 101: "SOL" });
export const USD_MICROS = 1_000_000;
/** Sanity ceiling in USD per native unit; a reader answering above it is a bug, not a market. */
export const MAX_NATIVE_USD = 10_000_000;

const DEFAULT_READERS = Object.freeze({ BNB: resolveBnbUsdPrice, ETH: resolveEthUsdPrice, SOL: resolveSolUsdPrice });

export function nativeUsdMicrosFromPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) throw new Error("native/USD price must be a positive number");
  if (n > MAX_NATIVE_USD) throw new Error("native/USD price is implausible");
  const micros = BigInt(Math.round(n * USD_MICROS));
  if (micros <= 0n) throw new Error("native/USD price rounds to zero");
  return micros;
}

/**
 * @returns {Promise<{chainId:number, asset:string, nativeUsdMicros:bigint, observedAtSeconds:number, source:string, cached:boolean}>}
 */
export async function readLiveNativeUsd(chainId, { readers = DEFAULT_READERS } = {}) {
  const chain = Number(chainId);
  const asset = NATIVE_ASSET_BY_CHAIN[chain];
  if (!asset) throw new Error(`no native/USD feed for chain ${chainId}`);
  const reader = readers[asset];
  if (typeof reader !== "function") throw new Error(`no ${asset}/USD reader`);
  const result = await reader();
  const price = Number(result?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`${asset}/USD price is unavailable`);
  const atMs = Number(result?.at);
  if (!Number.isFinite(atMs) || atMs <= 0) throw new Error(`${asset}/USD reader did not report an observation time`);
  return {
    chainId: chain,
    asset,
    nativeUsdMicros: nativeUsdMicrosFromPrice(price),
    observedAtSeconds: Math.floor(atMs / 1000),
    source: String(result.source || "spot"),
    cached: Boolean(result.cached),
  };
}

/** True when the operator pinned a price by hand under any of `keys`; the live feed is then not consulted. */
export function hasPinnedNativeUsd(env, keys) {
  return keys.some((key) => String(env?.[key] ?? "").trim() !== "");
}

/**
 * The env the sync pricing readers expect, built from a live observation:
 * price in micros, observation time as the snapshot timestamp, pricing
 * version from env (first non-empty of versionKey + fallbacks) or 1.
 */
export function withLiveSnapshot(env, { microsKey, updatedAtKey, versionKey, versionFallbackKeys = [] }, live) {
  const version = [versionKey, ...versionFallbackKeys].map((key) => env?.[key]).find((value) => String(value ?? "").trim() !== "") ?? "1";
  return {
    ...env,
    [microsKey]: live.nativeUsdMicros.toString(),
    [updatedAtKey]: String(live.observedAtSeconds),
    [versionKey]: String(version),
  };
}
