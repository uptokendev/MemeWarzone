import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sparklinePoints } from "@/lib/uiV2Format.mjs";
import { fetchMarketCandles, fetchMarketSummary } from "@/lib/marketContinuityApi";
import { fetchArenaImportCandles } from "@/lib/arenaImports";

/** Closing prices, oldest first, from either candle payload. */
function closes(items: Array<{ c?: string | null; price_c?: string | null }> | undefined) {
  return (items || []).map((c) => Number(c.price_c ?? c.c)).filter((v) => Number.isFinite(v) && v > 0);
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumSignificantDigits: 3 });

/**
 * Price line on the coin card in a post (founder, 2026-10-03; like X does for cashtags, but from the
 * contract address): USD price and change under the name, the line next to Buy. Launched coins read the
 * same candles and market summary as the coin page; imported coins read their DEX candles (already in
 * USD). Loads only when the card is on screen. Each part hides when its data is missing.
 */
export function useCoinMiniMarket({ chainId, campaign, token }: { chainId?: number | null; campaign?: string | null; token?: string | null }) {
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
  const data = useQuery({
    queryKey: ["coin-mini-market", chain, campaign || "", token || ""],
    enabled: visible && chain > 0 && Boolean(campaign || token),
    staleTime: 5 * 60_000,
    retry: 0,
    queryFn: async () => {
      if (campaign) {
        // The candle routes start at launch and ignore `from`, so read a longer window and keep the
        // most recent 48 hourly candles (hours with trades).
        const [candles, summary] = await Promise.all([
          fetchMarketCandles(campaign, chain, "1h", { limit: 1000 }).catch(() => null),
          fetchMarketSummary(campaign, chain).catch(() => null),
        ]);
        const price = Number((summary as { last_price_usd?: string | number | null } | null)?.last_price_usd);
        return { values: closes(candles?.items as any).slice(-48), priceUsd: Number.isFinite(price) && price > 0 ? price : null };
      }
      const imported = await fetchArenaImportCandles(String(token), chain, "1h").catch(() => null);
      const values = closes(imported?.items).slice(-48);
      return { values, priceUsd: values.length ? values[values.length - 1] : null };
    },
  }).data;

  const values = data?.values || [];
  const first = values[0];
  const last = values[values.length - 1];
  const change = values.length >= 2 && first > 0 ? (last / first - 1) * 100 : null;
  return { ref, values, change, priceUsd: data?.priceUsd ?? null };
}

/** "$0.0000260  +4.2%" under the coin name. */
export function CoinPriceLine({ ticker, priceUsd, change }: { ticker?: string | null; priceUsd: number | null; change: number | null }) {
  if (priceUsd == null && change == null) return null;
  return (
    <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 font-mw-mono text-sm" data-coin-price-line="true">
      {ticker ? <span className="text-mw-muted">${String(ticker).replace(/^\$/, "")}</span> : null}
      {priceUsd != null ? <span className="font-semibold text-mw-text">{usd.format(priceUsd)}</span> : null}
      {change != null ? (
        <span className={`font-semibold ${change >= 0 ? "text-[#6EE7A0]" : "text-mw-sell"}`}>
          {change >= 0 ? "+" : ""}
          {Math.abs(change) >= 1000 ? `${Math.round(change)}` : change.toFixed(1)}%
        </span>
      ) : null}
    </div>
  );
}

/**
 * The price line itself; nothing when there are fewer than two candles. It stretches between 56 and
 * 140 px and is dropped when the card is narrower than 340 px (the thread's side card), so the name
 * and price keep their room (rule in mw-v2.css, container `coin-card`).
 */
export function CoinSparkline({ values }: { values: number[] }) {
  const points = sparklinePoints(values, 120, 36);
  if (values.length < 2 || !points) return null;
  const up = values[values.length - 1] >= values[0];
  return (
    <div className="h-9 min-w-[56px] max-w-[140px] flex-1" data-coin-sparkline="true">
      <svg viewBox="0 0 120 36" preserveAspectRatio="none" className="block h-full w-full" role="img" aria-label="Recent price">
        <polyline points={points} fill="none" stroke={up ? "var(--mw-up)" : "var(--mw-down)"} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}
