// USD valuation for the finance read models. One place, server side.
//
// Spot: the readers the API already uses for UP votes, boosts and the league
// (bnbUsdPrice.js, ethUsdPrice.js, solUsdPrice.js): env override first, then
// Binance spot, cached in-process for 60 s.
//
// History: the same Binance API (public, no key), hourly klines. There is no
// native/USD history in the database (token_candles.reference_price_usd is
// empty on production, market_stats only holds the latest value), so an event
// is valued at the close of the hour it happened in. An hour that cannot be
// read falls back to spot and the figure says "at current price".
//
// Stablecoins (USDC, USDT) count as $1, the rule quoteAssetVerification.js
// already uses for stable quotes.
//
// A price that cannot be read is null, never 0. Read-only: no key, no signing.

import { resolveBnbUsdPrice } from "./bnbUsdPrice.js";
import { resolveEthUsdPrice } from "./ethUsdPrice.js";
import { resolveSolUsdPrice } from "./solUsdPrice.js";

const HOUR_MS = 3_600_000;
const KLINE_LIMIT = 1000;
const MAX_KLINE_REQUESTS = 30;
const KLINE_TIMEOUT_MS = 5000;
const STABLES = new Set(["USDC", "USDT"]);

export const PRICE_FEEDS = Object.freeze({
  SOL: { symbol: "SOLUSDT", envName: "SOL_USD_PRICE", fetchFlag: "SOL_USD_PRICE_FETCH", read: resolveSolUsdPrice },
  BNB: { symbol: "BNBUSDT", envName: "BNB_USD_PRICE", fetchFlag: "BNB_USD_PRICE_FETCH", read: resolveBnbUsdPrice },
  ETH: { symbol: "ETHUSDT", envName: "ETH_USD_PRICE", fetchFlag: "ETH_USD_PRICE_FETCH", read: resolveEthUsdPrice },
});

/** Which price an asset symbol is valued at: SOL, BNB, ETH, USD (stable) or null (no price). */
export function priceAssetFor(symbol) {
  const s = String(symbol || "").trim().toUpperCase();
  if (s === "SOL" || s === "WSOL") return "SOL";
  if (s === "BNB" || s === "WBNB") return "BNB";
  if (s === "ETH" || s === "WETH") return "ETH";
  if (STABLES.has(s)) return "USD";
  return null;
}

function roundUsd(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 1e6) / 1e6;
}

function decimalNumber(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function rawToNumber(raw, decimals) {
  const text = String(raw ?? "").split(".")[0];
  if (!/^\d+$/.test(text)) return null;
  return Number(text) / 10 ** decimals;
}

function hourStart(value) {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function fetchDisabled(feed, env) {
  return ["0", "false", "no", "off"].includes(String(env[feed.fetchFlag] ?? "1").trim().toLowerCase());
}

const sharedHistory = new Map();

/**
 * @param {object} [options]
 * @param {Record<string, Function>} [options.spotReaders]  asset -> async () => {price, source, at}
 * @param {Function} [options.fetchImpl]
 * @param {() => number} [options.nowMs]
 * @param {Record<string, string>} [options.env]
 * @param {Map} [options.historyCache]  asset -> Map(hourMs -> close)
 */
export function createPriceService({
  spotReaders,
  fetchImpl = fetch,
  nowMs = () => Date.now(),
  env = process.env,
  historyCache = sharedHistory,
} = {}) {
  const readers = spotReaders || Object.fromEntries(Object.entries(PRICE_FEEDS).map(([asset, feed]) => [asset, feed.read]));

  async function spot(asset) {
    if (asset === "USD") {
      return { asset: "USD", priceUsd: 1, source: "stablecoin counted as $1 (quote catalog rule)", at: new Date(nowMs()).toISOString() };
    }
    const feed = PRICE_FEEDS[asset];
    const reader = readers[asset];
    if (!feed || typeof reader !== "function") return null;
    try {
      const result = await reader();
      const price = Number(result?.price);
      if (!Number.isFinite(price) || price <= 0) return null;
      const atMs = Number(result?.at);
      return {
        asset,
        priceUsd: price,
        source: result?.source === "env" ? `env ${feed.envName} (operator override)` : `Binance ${feed.symbol} spot`,
        at: Number.isFinite(atMs) && atMs > 0 ? new Date(atMs).toISOString() : null,
      };
    } catch {
      return null;
    }
  }

  async function fetchKlines(feed, startMs, endMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), KLINE_TIMEOUT_MS);
    try {
      const params = new URLSearchParams({ symbol: feed.symbol, interval: "1h", startTime: String(startMs), endTime: String(endMs), limit: String(KLINE_LIMIT) });
      const res = await fetchImpl(`https://api.binance.com/api/v3/klines?${params.toString()}`, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!res.ok) return null;
      const rows = await res.json().catch(() => null);
      return Array.isArray(rows) ? rows : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Hourly closes for the given hour starts. Missing hours are left out of the map. */
  async function hourly(asset, hours) {
    const feed = PRICE_FEEDS[asset];
    const out = new Map();
    if (!feed) return out;
    const cache = historyCache.get(asset) || new Map();
    historyCache.set(asset, cache);
    const now = nowMs();
    const wanted = [...new Set(hours.filter((h) => Number.isFinite(h) && h + HOUR_MS <= now))].sort((a, b) => a - b);
    const missing = wanted.filter((h) => !cache.has(h));
    if (missing.length > 0 && !fetchDisabled(feed, env)) {
      let cursor = missing[0];
      const last = missing[missing.length - 1];
      for (let i = 0; i < MAX_KLINE_REQUESTS && cursor <= last; i += 1) {
        const end = Math.min(last, cursor + (KLINE_LIMIT - 1) * HOUR_MS);
        const rows = await fetchKlines(feed, cursor, end + HOUR_MS - 1);
        if (!rows) break;
        for (const row of rows) {
          const open = Number(row?.[0]);
          const close = Number(row?.[4]);
          // Only closed hours are cached: their close never changes.
          if (Number.isFinite(open) && Number.isFinite(close) && close > 0 && open + HOUR_MS <= now) cache.set(open, close);
        }
        const next = missing.find((h) => h > end);
        if (next == null) break;
        cursor = next;
      }
    }
    for (const h of wanted) if (cache.has(h)) out.set(h, cache.get(h));
    return out;
  }

  /**
   * Values a balance (or any amount without event times) at spot.
   * @returns {{amountUsd:number|null, priceUsd:number|null, priceSource:string|null, priceAt:string|null, priceBasis:'current'|null}}
   */
  async function valueAtSpot(symbol, amount) {
    const asset = priceAssetFor(symbol);
    const native = decimalNumber(amount);
    if (!asset || native == null) return { amountUsd: null, priceUsd: null, priceSource: null, priceAt: null, priceBasis: null };
    const price = await spot(asset);
    if (!price) return { amountUsd: null, priceUsd: null, priceSource: null, priceAt: null, priceBasis: null };
    return { amountUsd: roundUsd(native * price.priceUsd), priceUsd: price.priceUsd, priceSource: price.source, priceAt: price.at, priceBasis: "current" };
  }

  /**
   * Values amounts that happened at known times. `buckets` are [{hour, raw}]
   * in atomic units; a bucket without an hour, or an hour with no history, is
   * valued at spot. If any bucket cannot be priced at all the whole figure is
   * null, so a partial sum never poses as the total.
   * @returns {{amountUsd:number|null, priceUsd:number|null, priceSource:string|null, priceAt:string|null, priceBasis:'event_time'|'current'|'mixed'|null}}
   */
  async function valueEvents(symbol, buckets, decimals) {
    const asset = priceAssetFor(symbol);
    const empty = { amountUsd: null, priceUsd: null, priceSource: null, priceAt: null, priceBasis: null };
    if (!asset) return empty;
    const rows = (buckets || [])
      .map((b) => ({ hour: hourStart(b.hour), native: rawToNumber(b.raw, decimals) }))
      .filter((b) => b.native != null);
    if (asset === "USD") {
      const total = rows.reduce((sum, b) => sum + b.native, 0);
      const fixed = await spot("USD");
      return { amountUsd: roundUsd(total), priceUsd: 1, priceSource: fixed.source, priceAt: fixed.at, priceBasis: "current" };
    }
    const feed = PRICE_FEEDS[asset];
    const history = await hourly(asset, rows.map((b) => b.hour).filter((h) => h != null));
    let spotPrice;
    let usd = 0;
    let native = 0;
    let fromHistory = 0;
    let fromSpot = 0;
    let latestHour = null;
    for (const b of rows) {
      if (b.native === 0) continue;
      native += b.native;
      const close = b.hour != null ? history.get(b.hour) : undefined;
      if (close != null) {
        usd += b.native * close;
        fromHistory += 1;
        if (latestHour == null || b.hour > latestHour) latestHour = b.hour;
        continue;
      }
      if (spotPrice === undefined) spotPrice = await spot(asset);
      if (!spotPrice) return empty;
      usd += b.native * spotPrice.priceUsd;
      fromSpot += 1;
    }
    if (fromHistory === 0 && fromSpot === 0) {
      // Nothing moved: zero is a real zero. Show the spot price for reference.
      const ref = await spot(asset);
      return { amountUsd: 0, priceUsd: ref?.priceUsd ?? null, priceSource: ref?.source ?? null, priceAt: ref?.at ?? null, priceBasis: null };
    }
    const historySource = `Binance ${feed.symbol} 1h close at each event`;
    if (fromSpot === 0) {
      return { amountUsd: roundUsd(usd), priceUsd: roundUsd(usd / native), priceSource: historySource, priceAt: new Date(latestHour).toISOString(), priceBasis: "event_time" };
    }
    if (fromHistory === 0) {
      return { amountUsd: roundUsd(usd), priceUsd: spotPrice.priceUsd, priceSource: spotPrice.source, priceAt: spotPrice.at, priceBasis: "current" };
    }
    return { amountUsd: roundUsd(usd), priceUsd: roundUsd(usd / native), priceSource: `${historySource}; hours without history at ${spotPrice.source}`, priceAt: spotPrice.at, priceBasis: "mixed" };
  }

  /** Spot rows for the page footer: the price used, its source and time. */
  async function spotTable(assets) {
    const out = [];
    for (const asset of [...new Set(assets.filter(Boolean))]) {
      const price = await spot(asset);
      out.push(price ? { asset, priceUsd: price.priceUsd, source: price.source, at: price.at } : { asset, priceUsd: null, source: "no price", at: null });
    }
    return out;
  }

  return { spot, hourly, valueAtSpot, valueEvents, spotTable };
}

let defaultService = null;
export function defaultPriceService() {
  defaultService ||= createPriceService();
  return defaultService;
}

// --------------------------------------------------------------------------
// Totals. Native amounts are summed per chain and asset only: SOL, BNB and ETH
// never add up. USD is summed across everything that has a price; what has no
// price is counted, not guessed.

function splitDecimal(text) {
  const [whole, fraction = ""] = String(text).split(".");
  return { whole, fraction };
}

export function addDecimalStrings(a, b) {
  const x = splitDecimal(a);
  const y = splitDecimal(b);
  const scale = Math.max(x.fraction.length, y.fraction.length);
  const big = (p) => BigInt(`${p.whole}${p.fraction.padEnd(scale, "0")}` || "0");
  const sum = (big(x) + big(y)).toString();
  if (scale === 0) return sum;
  const padded = sum.padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function sumUsd(values) {
  const priced = values.filter((v) => v != null);
  return priced.length ? roundUsd(priced.reduce((s, v) => s + v, 0)) : null;
}

/**
 * @param {Array<{chainId:number, chain:string, asset:string, amount:string|null, amountUsd:number|null}>} entries
 * @param {{seed?: Array<{chainId:number, chain:string}>}} [options]
 */
export function buildTotals(entries, { seed = [] } = {}) {
  const chains = new Map();
  // Seeded chains appear in the breakdown even with nothing recorded.
  for (const s of seed) chains.set(Number(s.chainId), { chainId: Number(s.chainId), chain: s.chain, assets: new Map(), unknownAmountCount: 0 });
  let unknownAmountCount = 0;
  for (const entry of entries || []) {
    const key = Number(entry.chainId);
    if (!chains.has(key)) chains.set(key, { chainId: key, chain: entry.chain, assets: new Map(), unknownAmountCount: 0 });
    const chain = chains.get(key);
    if (entry.amount == null || !/^\d+(\.\d+)?$/.test(String(entry.amount))) {
      chain.unknownAmountCount += 1;
      unknownAmountCount += 1;
      continue;
    }
    const asset = String(entry.asset || "").toUpperCase();
    const row = chain.assets.get(asset) || { asset, amountNative: "0", usd: [], pricedCount: 0, missingPriceCount: 0 };
    row.amountNative = addDecimalStrings(row.amountNative, String(entry.amount));
    if (entry.amountUsd == null) row.missingPriceCount += 1;
    else { row.usd.push(entry.amountUsd); row.pricedCount += 1; }
    chain.assets.set(asset, row);
  }
  const byChain = [...chains.values()].map((chain) => {
    const assets = [...chain.assets.values()].map((row) => ({
      asset: row.asset,
      amountNative: row.amountNative,
      amountUsd: sumUsd(row.usd),
      pricedCount: row.pricedCount,
      missingPriceCount: row.missingPriceCount,
    }));
    return {
      chainId: chain.chainId,
      chain: chain.chain,
      assets,
      amountUsd: sumUsd(assets.map((a) => a.amountUsd)),
      pricedCount: assets.reduce((s, a) => s + a.pricedCount, 0),
      missingPriceCount: assets.reduce((s, a) => s + a.missingPriceCount, 0),
      unknownAmountCount: chain.unknownAmountCount,
    };
  });
  return {
    byChain,
    amountUsd: sumUsd(byChain.map((c) => c.amountUsd)),
    pricedCount: byChain.reduce((s, c) => s + c.pricedCount, 0),
    missingPriceCount: byChain.reduce((s, c) => s + c.missingPriceCount, 0),
    unknownAmountCount,
  };
}

/** Merges per-chain totals (from buildTotals) into one cross-chain total. */
export function mergeTotals(list) {
  const byChain = (list || []).filter(Boolean).flatMap((t) => t.byChain || []);
  return {
    byChain,
    amountUsd: sumUsd(byChain.map((c) => c.amountUsd)),
    pricedCount: byChain.reduce((s, c) => s + c.pricedCount, 0),
    missingPriceCount: byChain.reduce((s, c) => s + c.missingPriceCount, 0),
    unknownAmountCount: byChain.reduce((s, c) => s + (c.unknownAmountCount || 0), 0),
  };
}
