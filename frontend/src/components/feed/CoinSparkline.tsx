import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Sparkline } from "@/components/ui-v2/Sparkline";
import { fetchMarketCandles } from "@/lib/marketContinuityApi";
import { fetchArenaImportCandles } from "@/lib/arenaImports";

/** Closing prices, oldest first, from either candle payload. */
function closes(items: Array<{ c?: string | null; price_c?: string | null }> | undefined) {
  return (items || []).map((c) => Number(c.price_c ?? c.c)).filter((v) => Number.isFinite(v) && v > 0);
}

/**
 * Small price line on the coin card in a post (founder, 2026-10-03; like X does for cashtags, but from
 * the contract address). Launched coins read the same candles as the coin page chart; imported coins
 * read their DEX candles. Loads only when the card is on screen. Hidden when there is no history.
 */
export function CoinSparkline({ chainId, campaign, token }: { chainId?: number | null; campaign?: string | null; token?: string | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        io.disconnect();
      }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  const chain = Number(chainId || 0);
  const values =
    useQuery({
      queryKey: ["coin-sparkline", chain, campaign || "", token || ""],
      enabled: visible && chain > 0 && Boolean(campaign || token),
      staleTime: 5 * 60_000,
      retry: 0,
      queryFn: async () => {
        if (campaign) {
          // The candle routes start at launch and ignore `from`, so read a longer window and keep the
          // most recent 48 hourly candles (hours with trades).
          const hourly = closes((await fetchMarketCandles(campaign, chain, "1h", { limit: 1000 }).catch(() => null))?.items as any);
          return hourly.slice(-48);
        }
        const imported = await fetchArenaImportCandles(String(token), chain, "1h").catch(() => null);
        return closes(imported?.items).slice(-48);
      },
    }).data || [];

  const first = values[0];
  const last = values[values.length - 1];
  const change = values.length >= 2 && first > 0 ? (last / first - 1) * 100 : null;

  return (
    <div ref={ref} className="flex shrink-0 flex-col items-end gap-0.5" data-coin-sparkline="true">
      {values.length >= 2 ? (
        <>
          <Sparkline values={values} width={84} height={30} label="Recent price" />
          {change != null ? (
            <span className={`font-mw-mono text-xs font-semibold ${change >= 0 ? "text-[#6EE7A0]" : "text-mw-sell"}`}>
              {change >= 0 ? "+" : ""}
              {Math.abs(change) >= 1000 ? `${Math.round(change)}` : change.toFixed(1)}%
            </span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
