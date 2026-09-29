import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/apiBase";

type SolUsdState = {
  price: number | null;
  loading: boolean;
  error: string | null;
  updatedAt: number | null;
};

const STORAGE_KEY = "launchit:solUsdPrice:v1";
const CACHE_TTL_MS = 5 * 60 * 1000;
const ENABLE_SOL_USD_POLLING = String(import.meta.env.VITE_ENABLE_SOL_USD_POLLING || "").trim() === "1";

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
    // ignore
  }
}

export function useSolUsdPrice(enabled: boolean = true, refreshMs: number = 60_000): SolUsdState {
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
        // Our API, not CoinGecko: CoinGecko refuses browser calls (CORS, 403/429).
        const res = await apiFetch("/api/price/sol-usd", { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`SOL price fetch failed (${res.status})`);
        const data = await res.json() as any;
        const p = Number(data?.price);
        if (!Number.isFinite(p) || p <= 0) throw new Error("Invalid SOL/USD price");
        writeCache(p);
        if (!cancelled) {
          setPrice(p);
          setUpdatedAt(Date.now());
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setLoading(false);
          setError(e?.message ? String(e.message) : "SOL price fetch failed");
        }
      }
    };

    void fetchPrice(!cacheIsFresh);
    if (ENABLE_SOL_USD_POLLING) intervalId = window.setInterval(() => void fetchPrice(false), refreshMs);
    return () => {
      cancelled = true;
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [enabled, refreshMs, cacheIsFresh]);

  return { price, loading, error, updatedAt };
}
