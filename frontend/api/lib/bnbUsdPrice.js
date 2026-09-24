/**
 * BNB/USD for league prize USD estimates.
 *
 * Go-live path (priority order):
 * 1) BNB_USD_PRICE or LEAGUE_BNB_USD_PRICE env — ops override / pinned price
 * 2) Public spot ticker (Binance BNBUSDT) cached in-process — so testnet + mainnet
 *    show real USD without waiting for a custom oracle
 *
 * Set BNB_USD_PRICE_FETCH=0 to disable network fetch (env-only).
 */

const CACHE_TTL_MS = Math.max(15_000, Number(process.env.BNB_USD_PRICE_CACHE_MS || 60_000) || 60_000);
const FETCH_ENABLED = !["0", "false", "no", "off"].includes(
  String(process.env.BNB_USD_PRICE_FETCH || "1").trim().toLowerCase(),
);

let cache = { price: 0, at: 0, source: "none" };

function envPrice() {
  const n = Number(process.env.BNB_USD_PRICE || process.env.LEAGUE_BNB_USD_PRICE || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function fetchSpotBnbUsd() {
  if (!FETCH_ENABLED) return 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    // Public spot price — no API key. Used for prize *display* estimates only.
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT", {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return 0;
    const json = await res.json().catch(() => null);
    const n = Number(json?.price);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{ price: number, source: 'env'|'spot'|'none', cached: boolean, at: number }>}
 * `at` is the ms timestamp the price was observed (env read, spot fetch or the cache entry
 * being returned). Since 2026-09-24 boost and sponsorship quotes are signed off this
 * price (arenaNativeUsdFeed.mjs) and refuse an observation older than their max age,
 * so the stale-cache fallback below is a display convenience, never a signed price.
 */
export async function resolveBnbUsdPrice() {
  const fromEnv = envPrice();
  if (fromEnv > 0) {
    cache = { price: fromEnv, at: Date.now(), source: "env" };
    return { price: fromEnv, source: "env", cached: false, at: cache.at };
  }

  const now = Date.now();
  if (cache.price > 0 && now - cache.at < CACHE_TTL_MS) {
    return { price: cache.price, source: cache.source || "spot", cached: true, at: cache.at };
  }

  const spot = await fetchSpotBnbUsd();
  if (spot > 0) {
    cache = { price: spot, at: now, source: "spot" };
    return { price: spot, source: "spot", cached: false, at: now };
  }

  if (cache.price > 0) {
    return { price: cache.price, source: cache.source || "spot", cached: true, at: cache.at };
  }
  return { price: 0, source: "none", cached: false, at: 0 };
}

/** Sync read of last resolved price (env or cache). Prefer resolveBnbUsdPrice in handlers. */
export function readBnbUsdPriceSync() {
  const fromEnv = envPrice();
  if (fromEnv > 0) return fromEnv;
  return cache.price > 0 ? cache.price : 0;
}
