/**
 * SOL/USD in micro-dollars (BigInt) for the Solana money paths: trade authorization (every bonding
 * buy), graduation authorization and UP-vote ingest.
 *
 * Each of those used to call CoinGecko's free API directly on every request, with no cache and no
 * fallback. Under launch traffic CoinGecko answered 429 and every buy was refused with
 * "SOL/USD oracle is required to authorize a bonding buy" (2026-09-25). Now: several spot sources in
 * order, one shared in-flight lookup, a short cache, and -- only when every source is down -- the
 * last good price up to `maxStaleMs` old. Callers keep their own env override.
 */

const FRESH_MS = Math.max(5_000, Number(process.env.SOL_USD_MICROS_CACHE_MS || 20_000));
const DEFAULT_MAX_STALE_MS = Math.max(0, Number(process.env.SOL_USD_MICROS_MAX_STALE_MS || 300_000));

const SOURCES = [
  {
    name: "binance",
    url: "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT",
    read: (body) => Number(body?.price),
  },
  {
    name: "coinbase",
    url: "https://api.coinbase.com/v2/prices/SOL-USD/spot",
    read: (body) => Number(body?.data?.amount),
  },
  {
    name: "coingecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    read: (body) => Number(body?.solana?.usd),
  },
];

export function toUsdMicros(price) {
  const n = Number(price);
  // A SOL price outside this band is a broken response, not a market.
  if (!Number.isFinite(n) || n < 1 || n > 100_000) return 0n;
  return BigInt(Math.round(n * 1_000_000));
}

async function readSource(source, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(source.url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) throw new Error(`${source.name} HTTP ${response.status}`);
    const micros = toUsdMicros(source.read(await response.json()));
    if (micros <= 0n) throw new Error(`${source.name} returned no usable price`);
    return micros;
  } finally {
    clearTimeout(timer);
  }
}

export function createSolUsdMicrosReader({ fetchImpl = (...a) => fetch(...a), now = () => Date.now(), sources = SOURCES, timeoutMs = 3_500 } = {}) {
  let last = { micros: 0n, at: 0, source: "" };
  let inFlight = null;

  async function lookup() {
    const errors = [];
    for (const source of sources) {
      try {
        const micros = await readSource(source, fetchImpl, timeoutMs);
        last = { micros, at: now(), source: source.name };
        return micros;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`SOL/USD unavailable from every source: ${errors.join("; ")}`);
  }

  return async function readSolUsdMicros({ maxStaleMs = DEFAULT_MAX_STALE_MS } = {}) {
    if (last.micros > 0n && now() - last.at < FRESH_MS) return last.micros;
    try {
      inFlight ??= lookup().finally(() => { inFlight = null; });
      return await inFlight;
    } catch (error) {
      if (last.micros > 0n && now() - last.at <= maxStaleMs) {
        console.warn("[sol-usd] every source failed; using last good price", { ageMs: now() - last.at, source: last.source });
        return last.micros;
      }
      throw error;
    }
  };
}

const sharedReader = createSolUsdMicrosReader();

/** Shared process-wide reader. Throws only when no source answered and no recent price is known. */
export function readSolUsdMicros(options) {
  return sharedReader(options);
}
