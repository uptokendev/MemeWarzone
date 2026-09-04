import { BattleMetricBreakdown } from "@/components/arena/BattleMetricBreakdown";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { BATTLE_POINTS_V2_COMPONENT_MAX } from "@/lib/arena/battleWallMorePresentation.mjs";

export function BattleScoreBreakdown({
  metrics,
  maxes,
}: {
  metrics?: BattleRealtimeMetrics | null;
  maxes?: { marketCap?: number; holders?: number; volume?: number; boost?: number } | null;
}) {
  const resolved = maxes || BATTLE_POINTS_V2_COMPONENT_MAX;
  return (
    <section data-battle-score-breakdown="true" className="space-y-3">
      <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">Battle score breakdown</div>
      <div className="grid gap-3 md:grid-cols-2">
        <BattleMetricBreakdown side={metrics?.sides?.left} accent="ember" maxes={resolved} />
        <BattleMetricBreakdown side={metrics?.sides?.right} accent="cyan" maxes={resolved} />
      </div>
    </section>
  );
}
