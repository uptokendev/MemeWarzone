import { Activity, BarChart3, Gauge, Users } from "lucide-react";
import type { BattleRealtimeSide } from "@/lib/arena/battleRealtime";
import { formatCompactUsd, formatSignedPct } from "@/lib/arena/battlePresentation";
import { cn } from "@/lib/utils";

type Props = {
  side?: BattleRealtimeSide | null;
  accent?: "ember" | "cyan";
  maxes?: {
    marketCap?: number;
    holders?: number;
    volume?: number;
    boost?: number;
  };
};

function changePct(start: number | null, current: number | null) {
  if (start === null || current === null || start <= 0) return null;
  return ((current - start) / start) * 100;
}

function metricPointLabel(value: number | null, max: number, ready: boolean) {
  return ready && value != null ? `${value.toFixed(1)} / ${max}` : `— / ${max}`;
}

export function BattleMetricBreakdown({ side, accent = "ember", maxes }: Props) {
  const ready = side?.pointsReady === true;
  const mcapChange = side ? changePct(side.baseline.marketCapUsd, side.current.marketCapUsd) : null;
  const holderChange = side ? changePct(side.baseline.holders, side.current.holders) : null;
  const accentText = accent === "cyan" ? "text-cyan-300" : "text-orange-300";
  const progress = [
    {
      key: "mcap",
      label: "MCAP",
      icon: Activity,
      context: mcapChange === null ? "Awaiting baseline" : formatSignedPct(mcapChange),
      points: side?.points.marketCap ?? 0,
      max: maxes?.marketCap ?? 50,
      ready,
    },
    {
      key: "holders",
      label: "Holders",
      icon: Users,
      context: holderChange === null ? "Awaiting baseline" : formatSignedPct(holderChange),
      points: side?.points.holders ?? 0,
      max: maxes?.holders ?? 30,
      ready,
    },
    {
      key: "volume",
      label: "Battle vol",
      icon: BarChart3,
      context: formatCompactUsd(side?.eligibleBattleVolumeUsd ?? 0),
      points: side?.points.volume ?? 0,
      max: maxes?.volume ?? 20,
      ready,
    },
    ...(maxes?.boost
      ? [{
          key: "boost",
          label: "Battle Boost",
          icon: Gauge,
          context: side?.points.confirmedBoostUnits != null
            ? `${side.points.confirmedBoostUnits} confirmed Boost units`
            : "Awaiting authoritative Boost aggregate",
          points: side?.points.boost ?? null,
          max: maxes.boost,
          ready: ready && side?.points.boost != null,
        }]
      : []),
  ];
  const showAuthoritativeTotal = Boolean(maxes?.boost && side?.points.totalAuthoritative);

  return (
    <div className="space-y-2.5">
      {progress.map((item) => {
        const Icon = item.icon;
        const width = item.ready && item.points != null ? Math.max(0, Math.min(100, (item.points / item.max) * 100)) : 0;
        return (
          <div key={item.key} className="border border-white/8 bg-black/20 p-2.5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Icon className="h-3.5 w-3.5 shrink-0 text-white/42" />
                <div className="min-w-0">
                  <div className="text-[9px] uppercase tracking-[0.2em] text-white/42">{item.label}</div>
                  <div className="truncate text-xs text-white/78">{item.context}</div>
                </div>
              </div>
              <div className={cn("shrink-0 font-retro text-sm", item.ready ? accentText : "text-white/36")}>
                {metricPointLabel(item.points, item.max, item.ready)}
              </div>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/8">
              <div
                className={cn("h-full transition-[width] duration-500", accent === "cyan" ? "bg-cyan-300/75" : "bg-orange-300/75")}
                style={{ width: `${width}%` }}
              />
            </div>
          </div>
        );
      })}
      {showAuthoritativeTotal ? (
        <div data-battle-v3-authoritative-total="true" className="flex items-center justify-between gap-3 border border-white/10 bg-black/30 p-2.5">
          <div>
            <div className="text-[9px] uppercase tracking-[0.2em] text-white/42">Authoritative V3 total</div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-white/35">{side?.points.boostCurveVersion || "Backend-authoritative"}</div>
          </div>
          <div className={cn("font-retro text-base", accentText)}>{side?.points.total.toFixed(1)} / 100</div>
        </div>
      ) : null}
    </div>
  );
}
