import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/apiBase";
import { setVisibleInterval } from "@/lib/visibleInterval.mjs";

async function readJsonPrice(fetcher: () => Promise<Response>, pick: (body: any) => unknown): Promise<number> {
  const res = await fetcher();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const price = Number(pick(body));
  if (!Number.isFinite(price) || price <= 0) throw new Error("invalid price");
  return price;
}

async function fetchBnbUsdFromSources(): Promise<number> {
  const sources: Array<() => Promise<number>> = [
    () => readJsonPrice(() => apiFetch("/api/price/bnb-usd", { cache: "no-store" as RequestCache }), (body) => body?.price),
    () => readJsonPrice(() => fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT"), (body) => body?.price),
    () => readJsonPrice(
      () => fetch("https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd", { headers: { Accept: "application/json" } }),
      (body) => body?.binancecoin?.usd,
    ),
  ];
  for (const source of sources) {
    try {
      return await source();
    } catch {
      // try the next public source
    }
  }
  throw new Error("BNB/USD price unavailable");
}

type BnbUsdState = {
  price: number | null;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
};

const STORAGE_KEY = "launchit:bnbUsdPrice:v1";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ENABLE_BNB_USD_POLLING = String(import.meta.env.VITE_ENABLE_BNB_USD_POLLING || "").trim() === "1";

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
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ price, updatedAt: Date.now() })
    );
  } catch {
    // ignore
  }
}

/**
 * Fetches BNB/USD reference price for UI conversions.
 *
 * Default behavior is one fetch when cache is stale. Background polling is
 * disabled unless VITE_ENABLE_BNB_USD_POLLING=1 to avoid visible page loading
 * pulses on token pages.
 */
export function useBnbUsdPrice(enabled: boolean = true, refreshMs: number = 60_000): BnbUsdState {
  const cached = useMemo(() => (typeof window !== "undefined" ? readCache() : null), []);
  const cacheIsFresh = Boolean(cached && Date.now() - cached.updatedAt < CACHE_TTL_MS);

  const [price, setPrice] = useState<number | null>(cached?.price ?? null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(cached?.updatedAt ?? null);
  const [loading, setLoading] = useState<boolean>(enabled && !cacheIsFresh);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

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

        const p = await fetchBnbUsdFromSources();
        if (!Number.isFinite(p) || p <= 0) throw new Error("Invalid BNB/USD price");

        writeCache(p);

        if (!cancelled) {
          setPrice(p);
          setUpdatedAt(Date.now());
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          const stale = readCache();
          if (stale?.price) {
            setPrice(stale.price);
            setUpdatedAt(stale.updatedAt);
            setError(null);
          } else {
            setError(e?.message ? String(e.message) : "BNB price fetch failed");
          }
          setLoading(false);
        }
      }
    };

    fetchPrice(!cacheIsFresh);
    const stopPolling = ENABLE_BNB_USD_POLLING
      ? setVisibleInterval(() => { void fetchPrice(false); }, refreshMs)
      : null;

    return () => {
      cancelled = true;
      stopPolling?.();
    };
  }, [enabled, refreshMs, cacheIsFresh]);

  return { price, loading, error, updatedAt };
}
