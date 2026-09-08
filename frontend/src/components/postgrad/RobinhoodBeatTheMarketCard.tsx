import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRobinhoodBeatTheMarket, type RobinhoodBeatWindow } from "@/hooks/useRobinhoodBeatTheMarket";

const WINDOWS: RobinhoodBeatWindow[] = ["1h", "24h", "7d", "30d"];

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(value: unknown, signed = true): string {
  const parsed = number(value);
  if (parsed == null) return "—";
  const pct = parsed * 100;
  const prefix = signed && pct > 0 ? "+" : "";
  return `${prefix}${pct.toFixed(Math.abs(pct) >= 10 ? 1 : 2)}%`;
}

function points(value: unknown): string {
  const parsed = number(value);
  if (parsed == null) return "—";
  const prefix = parsed > 0 ? "+" : "";
  return `${prefix}${parsed.toFixed(Math.abs(parsed) >= 10 ? 1 : 2)} pp`;
}

function usd(value: unknown): string {
  const parsed = number(value);
  if (parsed == null || parsed <= 0) return "—";
  if (parsed >= 100) return `$${parsed.toFixed(2)}`;
  if (parsed >= 1) return `$${parsed.toFixed(3)}`;
  return `$${parsed.toFixed(6)}`;
}

export function RobinhoodBeatTheMarketCard({
  chainId,
  campaignAddress,
  memeSymbol = "MEME",
  quoteSymbol = "STOCK",
}: {
  chainId: number;
  campaignAddress: string;
  memeSymbol?: string;
  quoteSymbol?: string;
}) {
  const [windowKey, setWindowKey] = useState<RobinhoodBeatWindow>("24h");
  const { data, loading, error, updatedAt, refresh } = useRobinhoodBeatTheMarket({
    chainId,
    campaignAddress,
    window: windowKey,
    enabled: true,
    refreshMs: 60_000,
  });

  const metric = data?.metric || null;
  const healthy = Boolean(data?.healthy && metric?.healthy !== false);
  const unhealthyReason = String(data?.error || error || "Normalized market comparison is not healthy enough to rank.");
  const relative = number(metric?.relativeReturn);
  const isWinning = healthy && relative != null && relative > 0;
  const isTied = healthy && relative != null && Math.abs(relative) < 0.00005;

  return (
    <div className="rounded-[18px] border border-orange-400/20 bg-[linear-gradient(180deg,rgba(249,115,22,0.07),rgba(0,0,0,0.18))] p-3 md:rounded-[20px] md:p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.22em] text-orange-300">Beat the Market</div>
          <div className="mt-1 text-xs text-white/50">{memeSymbol} relative performance vs {quoteSymbol}</div>
        </div>
        <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={() => void refresh()} disabled={loading} aria-label="Refresh Beat the Market">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-1.5">
        {WINDOWS.map((value) => (
          <button
            type="button"
            key={value}
            onClick={() => setWindowKey(value)}
            className={`rounded-md border px-2 py-1.5 text-[10px] font-semibold transition ${windowKey === value ? "border-orange-400/60 bg-orange-500/15 text-orange-200" : "border-white/10 bg-black/20 text-white/45 hover:text-white/70"}`}
          >
            {value.toUpperCase()}
          </button>
        ))}
      </div>

      {healthy && metric ? (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <div className="rounded-lg border border-white/10 bg-black/25 p-2.5">
              <div className="text-[8px] uppercase tracking-[0.15em] text-white/35">{memeSymbol}</div>
              <div className="mt-1 text-sm font-semibold text-white">{percent(metric.memeReturn)}</div>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/25 p-2.5">
              <div className="text-[8px] uppercase tracking-[0.15em] text-white/35">{quoteSymbol}</div>
              <div className="mt-1 text-sm font-semibold text-white">{percent(metric.quoteAssetReturn)}</div>
            </div>
            <div className={`rounded-lg border p-2.5 ${isWinning ? "border-green-400/25 bg-green-500/10" : isTied ? "border-white/10 bg-black/25" : "border-red-400/20 bg-red-500/8"}`}>
              <div className="text-[8px] uppercase tracking-[0.15em] text-white/35">Relative</div>
              <div className={`mt-1 text-sm font-semibold ${isWinning ? "text-green-300" : isTied ? "text-white" : "text-red-200"}`}>{percent(metric.relativeReturn)}</div>
            </div>
          </div>

          <div className="mt-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2.5 text-[11px] text-white/55">
            <div className="flex items-center justify-between gap-3">
              <span>{isWinning ? `${memeSymbol} is beating ${quoteSymbol}` : isTied ? `${memeSymbol} is tracking ${quoteSymbol}` : `${memeSymbol} is trailing ${quoteSymbol}`}</span>
              <span className={isWinning ? "font-semibold text-green-300" : isTied ? "font-semibold text-white/75" : "font-semibold text-red-200"}>{points(metric.percentagePointDifference)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-white/30">
              <span>{usd(metric.startMemeUsd)} → {usd(metric.endMemeUsd)}</span>
              <span>{quoteSymbol} {usd(metric.startQuoteUsd)} → {usd(metric.endQuoteUsd)}</span>
              {data?.valuationSource ? <span>{data.valuationSource}</span> : null}
            </div>
          </div>
        </>
      ) : (
        <div className="mt-3 rounded-lg border border-yellow-400/20 bg-yellow-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-yellow-100/80">
          <div className="font-semibold">DATA DELAY · comparison hidden</div>
          <div className="mt-1 text-[10px] text-white/45">{unhealthyReason}</div>
        </div>
      )}

      <div className="mt-2 text-[9px] text-white/25">
        Normalized USD comparison only. No stale or unhealthy oracle/candle evidence is ranked.{updatedAt ? ` Updated ${new Date(updatedAt).toLocaleTimeString()}.` : ""}
      </div>
    </div>
  );
}
