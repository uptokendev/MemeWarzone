import { useEffect, useState } from "react";
import {
  fetchPublicPortfolio,
  type PublicPortfolioHolding,
} from "@/lib/profileApi";
import type { PortfolioMetrics } from "@/lib/profile/portfolioCalculations";

export function usePublicPortfolio(chainId?: number | null, address?: string | null) {
  const [metrics, setMetrics] = useState<PortfolioMetrics | null>(null);
  const [holdings, setHoldings] = useState<PublicPortfolioHolding[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const wallet = String(address || "").trim();
    const chain = Number(chainId);
    if (!wallet || !Number.isFinite(chain)) {
      setMetrics(null);
      setHoldings([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    void fetchPublicPortfolio(chain, wallet)
      .then((payload) => {
        if (cancelled) return;
        setMetrics(payload?.metrics ?? null);
        setHoldings(Array.isArray(payload?.holdings) ? payload.holdings : []);
      })
      .catch(() => {
        if (cancelled) return;
        setMetrics(null);
        setHoldings([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chainId, address]);

  return { metrics, holdings, loading };
}
