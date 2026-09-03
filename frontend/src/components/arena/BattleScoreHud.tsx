import { Clock3, Radio, Swords } from "lucide-react";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { battleClockLabel } from "@/lib/arena/battlePresentation";
import { cn } from "@/lib/utils";

type Props = {
  battle: Battle;
  metrics?: BattleRealtimeMetrics | null;
  leftLabel: string;
  rightLabel: string;
  realtimeState?: "idle" | "connecting" | "connected" | "disconnected" | "unavailable";
};

function score(value: number | undefined, ready: boolean) {
  return ready ? Number(value || 0).toFixed(1) : "—";
}

function tieBreakLabel(value: string | null | undefined) {
  if (value === "mcap_component") return "MCAP component";
  if (value === "holder_component") return "holder component";
  if (value === "volume_component") return "volume component";
  if (value === "token_address") return "token identity";
  if (value === "battle_points") return "Battle Points";
  return "deterministic rule";
}

export function BattleScoreHud({ battle, metrics, leftLabel, rightLabel, realtimeState = "idle" }: Props) {
  const left = metrics?.sides.left;
  const right = metrics?.sides.right;
  const ready = left?.pointsReady === true && right?.pointsReady === true;
  const leader = ready ? metrics?.leaderSide ?? null : null;
  const leaderLabel = leader === "left"
    ? leftLabel
    : leader === "right"
      ? rightLabel
      : leader === "tied"
        ? "Dead even"
        : metrics?.dataHealth.status === "data_delay"
          ? "Data delay"
          : "Calculating";
  const gap = ready && metrics?.pointDifference !== null && metrics?.pointDifference !== undefined
    ? metrics.pointDifference.toFixed(1)
    : null;
  const live = battle.state === "live";
  const settlementV2 = metrics?.settlementMode === "battle_points_v2";

  return (
    <section className="mwz-hud-frame relative flex min-h-[420px] flex-col justify-between overflow-hidden p-4 md:p-5">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.06),transparent_62%)]" />
      <div className="relative space-y-5">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <TacticalTag label="Battle Points V2" tone="hot" />
          <TacticalTag label={settlementV2 ? "Settlement V2" : "Settlement V1"} tone={settlementV2 ? "success" : "default"} />
          {metrics?.tieBreakUsed ? <TacticalTag label="TIE-BREAK" tone="sponsored" /> : null}
        </div>

        <div className="text-center">
          <div className="text-[10px] uppercase tracking-[0.28em] text-white/42">Combat HUD</div>
          <div className={cn(
            "mt-2 font-retro text-2xl uppercase md:text-3xl",
            leader === "left" ? "text-orange-200" : leader === "right" ? "text-cyan-200" : "text-white/82",
          )}>
            {leader === "left" || leader === "right" ? `${leaderLabel} leads` : leaderLabel}
          </div>
          <div className="mt-5 flex items-center justify-center gap-4 font-retro text-4xl text-foreground md:text-5xl">
            <span className={leader === "left" ? "text-orange-200" : undefined}>{score(left?.points.total, left?.pointsReady === true)}</span>
            <Swords className="h-6 w-6 text-white/30" />
            <span className={leader === "right" ? "text-cyan-200" : undefined}>{score(right?.points.total, right?.pointsReady === true)}</span>
          </div>
          <div className="mt-2 text-[10px] uppercase tracking-[0.22em] text-white/45">
            {gap ? `+${gap} point lead` : ready ? "0.0 point gap" : "Live score pending"}
          </div>
        </div>

        <div className="grid gap-2 text-xs uppercase tracking-[0.18em] text-white/48">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <span>{leftLabel}</span>
            <span className="font-retro text-sm text-orange-200/90">{score(left?.points.total, left?.pointsReady === true)}</span>
          </div>
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <span>{rightLabel}</span>
            <span className="font-retro text-sm text-cyan-200/90">{score(right?.points.total, right?.pointsReady === true)}</span>
          </div>
        </div>
      </div>

      <div className="relative space-y-3 border-t border-white/10 pt-4">
        <div className="flex items-center gap-2 text-sm text-white/72">
          <Clock3 className="h-4 w-4 text-white/45" />
          <div>
            <div className="text-[9px] uppercase tracking-[0.2em] text-white/38">Time remaining</div>
            <div className="font-medium text-white">{battleClockLabel(battle)}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs text-white/52">
          <Radio className={cn("h-3.5 w-3.5", realtimeState === "connected" ? "text-emerald-300" : "text-white/35")} />
          <span>
            {realtimeState === "connected"
              ? "Realtime Battle telemetry linked"
              : realtimeState === "disconnected"
                ? "Realtime reconnecting — REST remains authoritative"
                : realtimeState === "unavailable"
                  ? "Realtime unavailable — REST snapshot active"
                  : "Connecting Battle telemetry"}
          </span>
        </div>
        {!metrics?.dataHealth.healthy ? (
          <div className="border border-amber-300/20 bg-amber-300/[0.05] px-3 py-2 text-xs text-amber-100/80">
            DATA DELAY — Battle Points are not treated as current until both combatants have healthy persisted metrics.
          </div>
        ) : null}
        {metrics?.tieBreakUsed ? (
          <div className="border border-fuchsia-300/20 bg-fuchsia-300/[0.04] px-3 py-2 text-xs text-fuchsia-100/80">
            TIE-BREAK — the ranked result was functionally tied; the money recipient was selected by {tieBreakLabel(metrics.moneyTieBreak)}.
          </div>
        ) : null}
        {live ? (
          <div className="text-[10px] leading-4 text-white/36">
            {settlementV2
              ? "Battle Points V2 are authoritative for this fight. Final settlement re-runs the same server scoring path at battle close and fails closed on delayed data."
              : "Battle Points are live telemetry on this rollout. Existing V1 settlement remains authoritative until the settlement migration is enabled and certified."}
          </div>
        ) : null}
      </div>
    </section>
  );
}
