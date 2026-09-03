import { Link } from "react-router-dom";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { battleClockLabel } from "@/lib/arena/battlePresentation";
import { DATA_DELAY_LABEL, presentBattleWallModule } from "@/lib/arena/battleWallPresentation.mjs";
import { WarzoneTokenMark } from "@/components/warzone/WarzoneTokenMark";

function participantArt(battle: Battle, index: number) {
  const participant = battle.participants?.[index] as { imageUrl?: string; logoUri?: string } | undefined;
  return participant?.imageUrl || participant?.logoUri || null;
}

export function WarzoneBattlePreview({
  battle,
  metrics,
  metricsRequested = false,
  metricsLoaded = false,
}: {
  battle: Battle;
  metrics?: BattleRealtimeMetrics | null;
  metricsRequested?: boolean;
  metricsLoaded?: boolean;
}) {
  const presented = presentBattleWallModule(battle, metrics, {
    requested: metricsRequested,
    loaded: metricsLoaded,
  });
  const delayed = presented.scoreKind === "delay" || presented.statusLabel === DATA_DELAY_LABEL;
  const showScores = !delayed && Boolean(presented.leftPointsLabel && presented.rightPointsLabel);
  const left = battle.participants?.[0];
  const right = battle.participants?.[1];
  const stateLabel = presented.tab === "live" ? "LIVE" : presented.tab === "upcoming" ? "UPCOMING" : "FINISHED";
  const clock = presented.tab === "upcoming" ? null : battleClockLabel(battle);

  return (
    <Link
      to={presented.href}
      data-warzone-battle-preview={battle.id}
      className="mwz-flat-card block min-w-0 p-3"
    >
      <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em] text-white/50">
        <span className={presented.tab === "live" ? "text-orange-200" : "text-white/70"}>{stateLabel}</span>
        {clock ? <span>{clock}</span> : null}
      </div>
      <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <WarzoneTokenMark imageUrl={participantArt(battle, 0)} symbol={left?.symbol} name={left?.tokenName} size="sm" />
          <div className="min-w-0">
            <div className="truncate font-retro text-sm text-foreground">{presented.leftTicker}</div>
            {showScores ? (
              <div className="text-[10px] uppercase tracking-[0.14em] text-white/50">
                {presented.leftPointsLabel} {presented.scoreKind === "legacy" ? "SCORE" : "BP"}
              </div>
            ) : null}
          </div>
        </div>
        <div className="px-1 text-center font-retro text-lg uppercase tracking-[0.18em] text-orange-400">VS</div>
        <div className="flex min-w-0 items-center justify-end gap-2">
          <div className="min-w-0 text-right">
            <div className="truncate font-retro text-sm text-foreground">{presented.rightTicker}</div>
            {showScores ? (
              <div className="text-[10px] uppercase tracking-[0.14em] text-white/50">
                {presented.rightPointsLabel} {presented.scoreKind === "legacy" ? "SCORE" : "BP"}
              </div>
            ) : null}
          </div>
          <WarzoneTokenMark imageUrl={participantArt(battle, 1)} symbol={right?.symbol} name={right?.tokenName} size="sm" />
        </div>
      </div>
      {delayed ? (
        <div className="mt-2 text-center font-retro text-[10px] uppercase tracking-[0.16em] text-orange-200">{DATA_DELAY_LABEL}</div>
      ) : presented.statusLabel && !showScores ? (
        <div className="mt-2 text-center text-[10px] uppercase tracking-[0.14em] text-orange-200/80">{presented.statusLabel}</div>
      ) : null}
    </Link>
  );
}
