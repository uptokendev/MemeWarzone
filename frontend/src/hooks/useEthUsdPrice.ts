import { useEffect, useMemo, useState } from "react";

async function readJsonPrice(fetcher: () => Promise<Response>, pick: (body: any) => unknown): Promise<number> {
  const res = await fetcher();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const price = Number(pick(body));
  if (!Number.isFinite(price) || price <= 0) throw new Error("invalid price");
  return price;
}

async function fetchEthUsdFromSources(): Promise<number> {
  const sources: Array<() => Promise<number>> = [
    () => readJsonPrice(
      () => fetch("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT"),
      (body) => body?.price,
    ),
    () => readJsonPrice(
      () => fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { headers: { Accept: "application/json" } }),
      (body) => body?.data?.amount,
    ),
    () => readJsonPrice(
      () => fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { headers: { Accept: "application/json" } }),
      (body) => body?.ethereum?.usd,
    ),
  ];
  for (const source of sources) {
    try {
      return await source();
    } catch {
      // try next independent ETH source
    }
  }
  throw new Error("ETH/USD price unavailable");
}

type EthUsdState = {
  price: number | null;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
};

const STORAGE_KEY = "memewarzone:ethUsdPrice:v1";
const CACHE_TTL_MS = 5 * 60 * 1000;
const ENABLE_ETH_USD_POLLING = String(import.meta.env.VITE_ENABLE_ETH_USD_POLLING || "").trim() === "1";

function readCache(): { price: number; updatedAt: number } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { price?: unknown; updatedAt?: unknown };
    const price = typeof parsed.price === "number" ? parsed.price : null;
    const updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : null;
    if (price == null || updatedAt == null) return null;
    return { price, updatedAt };
  } catch {
    return null;
  }
}

function writeCache(price: number) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ price, updatedAt: Date.now() }));
  } catch {
    // ignore cache failures
  }
}

export function useEthUsdPrice(enabled: boolean = true, refreshMs: number = 60_000): EthUsdState {
  const cached = useMemo(() => (typeof window !== "undefined" ? readCache() : null), []);
  const cacheIsFresh = Boolean(cached && Date.now() - cached.updatedAt < CACHE_TTL_MS);
  const [price, setPrice] = useState<number | null>(cached?.price ?? null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(cached?.updatedAt ?? null);
  const [loading, setLoading] = useState<boolean>(enabled && !cacheIsFresh);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let intervalId: number | undefined;

    const fetchPrice = async (showLoading: boolean) => {
      try {
        setError(null);
        const cache = readCache();
        if (cache && Date.now() - cache.updatedAt < CACHE_TTL_MS) {
          if (!cancelled) {
            setPrice(cache.price);
            setUpdatedAt(cache.updatedAt);
            setLoading(false);
          }
          return;
        }
        if (showLoading) setLoading(true);
        const next = await fetchEthUsdFromSources();
        writeCache(next);
        if (!cancelled) {
          setPrice(next);
          setUpdatedAt(Date.now());
          setLoading(false);
        }
      } catch (error: any) {
        if (!cancelled) {
          const stale = readCache();
          if (stale?.price) {
            setPrice(stale.price);
            setUpdatedAt(stale.updatedAt);
            setError(null);
          } else {
            setError(error?.message ? String(error.message) : "ETH price fetch failed");
          }
          setLoading(false);
        }
      }
    };

    void fetchPrice(!cacheIsFresh);
    if (ENABLE_ETH_USD_POLLING) intervalId = window.setInterval(() => void fetchPrice(false), refreshMs);
    return () => {
      cancelled = true;
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [enabled, refreshMs, cacheIsFresh]);

  return { price, loading, error, updatedAt };
}
