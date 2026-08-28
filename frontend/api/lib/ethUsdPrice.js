/**
 * ETH/USD for Robinhood-native accounting and universal recruiter ranking.
 *
 * Priority:
 * 1) ETH_USD_PRICE or LEAGUE_ETH_USD_PRICE env
 * 2) Binance ETHUSDT spot, cached in-process
 *
 * Set ETH_USD_PRICE_FETCH=0 to disable network fetch.
 */

const CACHE_TTL_MS = Math.max(15_000, Number(process.env.ETH_USD_PRICE_CACHE_MS || 60_000) || 60_000);
const FETCH_ENABLED = !["0", "false", "no", "off"].includes(
  String(process.env.ETH_USD_PRICE_FETCH || "1").trim().toLowerCase(),
);

let cache = { price: 0, at: 0, source: "none" };

function envPrice() {
  const n = Number(process.env.ETH_USD_PRICE || process.env.LEAGUE_ETH_USD_PRICE || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function fetchSpotEthUsd() {
  if (!FETCH_ENABLED) return 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", {
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

export async function resolveEthUsdPrice() {
  const fromEnv = envPrice();
  if (fromEnv > 0) {
    cache = { price: fromEnv, at: Date.now(), source: "env" };
    return { price: fromEnv, source: "env", cached: false };
  }

  const now = Date.now();
  if (cache.price > 0 && now - cache.at < CACHE_TTL_MS) {
    return { price: cache.price, source: cache.source || "spot", cached: true };
  }

  const spot = await fetchSpotEthUsd();
  if (spot > 0) {
    cache = { price: spot, at: now, source: "spot" };
    return { price: spot, source: "spot", cached: false };
  }

  if (cache.price > 0) {
    return { price: cache.price, source: cache.source || "spot", cached: true };
  }
  return { price: 0, source: "none", cached: false };
}

export function readEthUsdPriceSync() {
  const fromEnv = envPrice();
  if (fromEnv > 0) return fromEnv;
  return cache.price > 0 ? cache.price : 0;
}
