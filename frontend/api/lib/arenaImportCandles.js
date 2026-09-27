/**
 * Chart candles for imported tokens (2026-09-27, founder: "they are tokens that already have full data
 * and a chart that should show everything").
 *
 * The indexer only follows MemeWarzone's own pools, so /api/token/<addr>/candles is empty for an import.
 * An import already trades on a DEX with years of history, and the market feed already records its
 * deepest pool (arena_import_market_stats.pair_address, from DexScreener). GeckoTerminal serves OHLCV
 * for that pool; this module turns it into the candle rows the chart reads.
 *
 * Units: USD. Price candles come straight from GeckoTerminal (currency=usd, token=<the import>); market
 * cap candles are price x the supply implied by the feed's current market cap / price, so the chart's
 * last market-cap bar agrees with the header. The client divides by the same native/USD rate it hands
 * the chart, so what the chart multiplies back is exactly these USD values.
 *
 * GeckoTerminal's free tier is ~30 calls/min per IP and the market feed in the realtime worker spends up
 * to 20 of them, so this path is capped separately (ARENA_IMPORT_CANDLES_GECKO_PER_MIN, default 8),
 * cached per pool+timeframe, and concurrent requests for the same key share one upstream call. Over the
 * cap a stale cache entry is served; with none, the caller gets `rateLimited` and retries.
 */

/** Chart resolution -> GeckoTerminal timeframe/aggregate. 30m is built from two 15m bars. */
export const IMPORT_CANDLE_TIMEFRAMES = {
  "1m": { timeframe: "minute", aggregate: 1, seconds: 60, ttlMs: 30_000 },
  "5m": { timeframe: "minute", aggregate: 5, seconds: 300, ttlMs: 60_000 },
  "15m": { timeframe: "minute", aggregate: 15, seconds: 900, ttlMs: 60_000 },
  "30m": { timeframe: "minute", aggregate: 15, seconds: 1800, ttlMs: 60_000, merge: 2 },
  "1h": { timeframe: "hour", aggregate: 1, seconds: 3600, ttlMs: 120_000 },
  "4h": { timeframe: "hour", aggregate: 4, seconds: 14_400, ttlMs: 300_000 },
  "1d": { timeframe: "day", aggregate: 1, seconds: 86_400, ttlMs: 600_000 },
};

const GECKO_LIMIT = 1000; // GeckoTerminal's maximum bars per request

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** GeckoTerminal ohlcv_list ([ts, o, h, l, c, volumeUsd], newest first) -> ascending bars. Bad rows are dropped. */
export function parseGeckoOhlcv(json) {
  const list = json?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const bars = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [ts, o, h, l, c, v] = row.map(Number);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue;
    bars.push({ time: Math.floor(ts), o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v: Number.isFinite(v) && v >= 0 ? v : 0 });
  }
  bars.sort((a, b) => a.time - b.time);
  const unique = [];
  for (const bar of bars) if (!unique.length || unique[unique.length - 1].time !== bar.time) unique.push(bar);
  return unique;
}

/** Merge ascending bars into buckets of `seconds` (used for 30m from 15m). */
export function mergeBars(bars, seconds) {
  const out = [];
  for (const bar of bars) {
    const bucket = Math.floor(bar.time / seconds) * seconds;
    const last = out[out.length - 1];
    if (last && last.time === bucket) {
      last.h = Math.max(last.h, bar.h);
      last.l = Math.min(last.l, bar.l);
      last.c = bar.c;
      last.v += bar.v;
    } else {
      out.push({ ...bar, time: bucket });
    }
  }
  return out;
}

/**
 * Supply implied by the feed's market cap and price, so market-cap bars agree with the header.
 * Falls back to the newest bar's close when the feed has no price (DexScreener rows often omit it).
 */
export function impliedSupply(marketCapUsd, priceUsd, bars) {
  const cap = finitePositive(marketCapUsd);
  if (!cap) return null;
  const price = finitePositive(priceUsd) || finitePositive(bars?.[bars.length - 1]?.c);
  return price ? cap / price : null;
}

/** Bars -> the chart's candle rows (USD). trades_count 1 marks the bar as real for the chart's filter. */
export function toCandleRows(bars, supply) {
  const s = finitePositive(supply);
  return bars.map((bar) => ({
    bucket_start: new Date(bar.time * 1000).toISOString(),
    o: String(bar.o),
    h: String(bar.h),
    l: String(bar.l),
    c: String(bar.c),
    mcap_o: s ? String(bar.o * s) : null,
    mcap_h: s ? String(bar.h * s) : null,
    mcap_l: s ? String(bar.l * s) : null,
    mcap_c: s ? String(bar.c * s) : null,
    volume_usd: String(bar.v),
    trades_count: 1,
  }));
}

/** Wrapped native per chain: a trade quoted in it has a native amount; anything else shows USD only. */
export const WRAPPED_NATIVE = {
  101: "So11111111111111111111111111111111111111112",
  56: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  4663: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
};
export const IMPORT_TRADES_TTL_MS = 30_000;

function sameAddress(chainId, a, b) {
  const x = String(a || "").trim();
  const y = String(b || "").trim();
  if (!x || !y) return false;
  return Number(chainId) === 101 ? x === y : x.toLowerCase() === y.toLowerCase();
}

/**
 * GeckoTerminal pool trades (last 24h, newest first) -> rows in the import's own terms. `kind` is
 * already relative to the `token` query parameter; it is re-derived from the token legs so a response
 * that ignored the parameter cannot flip buys and sells. Rows not involving the import are dropped.
 */
export function parseGeckoTrades(json, chainId, tokenAddress) {
  const list = json?.data;
  if (!Array.isArray(list)) return [];
  const native = WRAPPED_NATIVE[Number(chainId)] || "";
  const out = [];
  for (const entry of list) {
    const a = entry?.attributes;
    if (!a?.tx_hash) continue;
    const sold = sameAddress(chainId, a.from_token_address, tokenAddress);
    const bought = sameAddress(chainId, a.to_token_address, tokenAddress);
    if (sold === bought) continue;
    const side = bought ? "buy" : "sell";
    const tokenAmount = Number(bought ? a.to_token_amount : a.from_token_amount);
    const quoteAddress = bought ? a.from_token_address : a.to_token_address;
    const quoteAmount = Number(bought ? a.from_token_amount : a.to_token_amount);
    const time = Date.parse(String(a.block_timestamp || ""));
    if (!Number.isFinite(tokenAmount) || tokenAmount <= 0 || !Number.isFinite(time)) continue;
    const volumeUsd = Number(a.volume_in_usd);
    out.push({
      txHash: String(a.tx_hash),
      side,
      maker: String(a.tx_from_address || "") || null,
      tokenAmount,
      nativeAmount: sameAddress(chainId, quoteAddress, native) && Number.isFinite(quoteAmount) && quoteAmount > 0 ? quoteAmount : null,
      volumeUsd: Number.isFinite(volumeUsd) && volumeUsd >= 0 ? volumeUsd : null,
      blockTime: Math.floor(time / 1000),
      blockNumber: Number(a.block_number) || null,
    });
  }
  out.sort((x, y) => y.blockTime - x.blockTime);
  return out;
}

export function createCandleSource({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const key = String(env.COINGECKO_API_KEY || "").trim();
  const base = key ? "https://pro-api.coingecko.com/api/v3/onchain" : "https://api.geckoterminal.com/api/v2";
  const perMinute = Math.max(1, Number(env.ARENA_IMPORT_CANDLES_GECKO_PER_MIN) || (key ? 120 : 8));
  const cache = new Map();
  const inflight = new Map();
  let windowStart = 0;
  let used = 0;

  function takeCall() {
    const t = now();
    if (t - windowStart >= 60_000) {
      windowStart = t;
      used = 0;
    }
    if (used >= perMinute) return false;
    used += 1;
    return true;
  }

  async function fetchBars(network, pairAddress, tokenAddress, spec) {
    const url = `${base}/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(pairAddress)}/ohlcv/${spec.timeframe}`
      + `?aggregate=${spec.aggregate}&limit=${GECKO_LIMIT}&currency=usd&token=${encodeURIComponent(tokenAddress)}`;
    const res = await fetchImpl(url, {
      headers: { accept: "application/json", ...(key ? { "x-cg-pro-api-key": key } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
    const bars = parseGeckoOhlcv(await res.json());
    return spec.merge ? mergeBars(bars, spec.seconds) : bars;
  }

  /** @returns {{ bars: Array, stale: boolean, rateLimited: boolean }} */
  async function bars({ network, pairAddress, tokenAddress, resolution }) {
    const spec = IMPORT_CANDLE_TIMEFRAMES[resolution];
    if (!spec) throw new Error(`unsupported resolution ${resolution}`);
    const cacheKey = `${network}:${pairAddress}:${tokenAddress}:${resolution}`;
    const hit = cache.get(cacheKey);
    if (hit && now() - hit.at < spec.ttlMs) return { bars: hit.bars, stale: false, rateLimited: false };
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);
    if (!takeCall()) return { bars: hit?.bars || [], stale: Boolean(hit), rateLimited: !hit };
    const request = fetchBars(network, pairAddress, tokenAddress, spec)
      .then((fresh) => {
        cache.set(cacheKey, { at: now(), bars: fresh });
        return { bars: fresh, stale: false, rateLimited: false };
      })
      .catch((error) => {
        if (hit) return { bars: hit.bars, stale: true, rateLimited: false };
        throw error;
      })
      .finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, request);
    return request;
  }

  /** Recent pool trades; same budget, cache and coalescing as the candles. */
  async function trades({ network, pairAddress, tokenAddress, chainId }) {
    const cacheKey = `trades:${network}:${pairAddress}:${tokenAddress}`;
    const hit = cache.get(cacheKey);
    if (hit && now() - hit.at < IMPORT_TRADES_TTL_MS) return { trades: hit.bars, stale: false, rateLimited: false };
    if (inflight.has(cacheKey)) return inflight.get(cacheKey);
    if (!takeCall()) return { trades: hit?.bars || [], stale: Boolean(hit), rateLimited: !hit };
    const url = `${base}/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(pairAddress)}/trades?token=${encodeURIComponent(tokenAddress)}`;
    const request = fetchImpl(url, {
      headers: { accept: "application/json", ...(key ? { "x-cg-pro-api-key": key } : {}) },
      signal: AbortSignal.timeout(15_000),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`);
        const fresh = parseGeckoTrades(await res.json(), chainId, tokenAddress);
        cache.set(cacheKey, { at: now(), bars: fresh });
        return { trades: fresh, stale: false, rateLimited: false };
      })
      .catch((error) => {
        if (hit) return { trades: hit.bars, stale: true, rateLimited: false };
        throw error;
      })
      .finally(() => inflight.delete(cacheKey));
    inflight.set(cacheKey, request);
    return request;
  }

  return { bars, trades };
}
