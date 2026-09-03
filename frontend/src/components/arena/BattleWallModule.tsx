import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BattleCombatEffects } from "@/components/arena/BattleCombatEffects";
import { BattleWallCombatant } from "@/components/arena/BattleWallCombatant";
import { BattleWallVs } from "@/components/arena/BattleWallVs";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { useBattleWallRealtime } from "@/hooks/useBattleWallRealtime";
import { useBattleWallViewport, type BattleWallViewportReport } from "@/hooks/useBattleWallViewport";
import { battleChainLabel, battleClockLabel, battleDurationLabel } from "@/lib/arena/battlePresentation";
import { battleDomId, presentBattleWallModule } from "@/lib/arena/battleWallPresentation.mjs";
import {
  isWallRealtimeEligible,
  retainWallRealtimeMetrics,
  selectWallModuleMetrics,
  shouldMountWallCombatEffects,
} from "@/lib/arena/battleWallRealtime.mjs";
import { getNativeSymbol } from "@/lib/chainConfig";

function noopViewportReport(_report: BattleWallViewportReport) {}

type Props = {
  battle: Battle;
  metrics?: BattleRealtimeMetrics | null;
  metricsRequested?: boolean;
  metricsLoaded?: boolean;
  realtimeActive?: boolean;
  viewportIndex?: number;
  onViewportReport?: (report: BattleWallViewportReport) => void;
};

export function BattleWallModule({
  battle,
  metrics,
  metricsRequested = false,
  metricsLoaded = false,
  realtimeActive = false,
  viewportIndex = 0,
  onViewportReport,
}: Props) {
  const moduleRef = useRef<HTMLElement | null>(null);
  const live = isWallRealtimeEligible(battle);
  const realtime = useBattleWallRealtime(battle.id, realtimeActive && live);
  const [retained, setRetained] = useState<{ value: BattleRealtimeMetrics | null } | null>(null);
  const report = onViewportReport || noopViewportReport;

  useBattleWallViewport(moduleRef, {
    battleId: battle.id,
    live,
    index: viewportIndex,
    onReport: report,
  });

  useEffect(() => {
    setRetained((previous) =>
      retainWallRealtimeMetrics(previous, realtimeActive && live, realtime.snapshotReady, realtime.metrics),
    );
  }, [live, realtime.metrics, realtime.snapshotReady, realtimeActive]);

  const selected = selectWallModuleMetrics({
    realtimeActive: realtimeActive && live,
    snapshotReady: realtime.snapshotReady,
    realtimeMetrics: realtime.metrics,
    retained,
    feedMetrics: metrics,
    feedRequested: metricsRequested,
    feedLoaded: metricsLoaded,
  });
  const displayBattle =
    realtimeActive && live && realtime.snapshotReady && realtime.battle?.id === battle.id
      ? realtime.battle
      : battle;
  const displayMetrics = selected.metrics;
  const presented = presentBattleWallModule(displayBattle, displayMetrics, {
    requested: selected.requested,
    loaded: selected.loaded,
  });
  const chainId = Number((displayBattle as Battle & { chainId?: number }).chainId || 0);
  const upcoming = presented.tab === "upcoming";
  const left = displayBattle.participants?.[0];
  const right = displayBattle.participants?.[1];
  const mountEffects = shouldMountWallCombatEffects({
    live,
    realtimeActive,
    snapshotReady: realtime.snapshotReady,
  });

  const stateLabel = presented.tab === "live" ? "LIVE" : presented.tab === "upcoming" ? "DEPLOYMENT PENDING" : "FINISHED";
  const moduleTone =
    presented.tab === "live"
      ? "border-orange-400/20"
      : presented.tab === "upcoming"
        ? "border-white/10 opacity-95"
        : "border-white/10 bg-black/20";

  return (
    <article
      ref={moduleRef}
      id={battleDomId(battle.id)}
      data-battle-id={battle.id}
      data-battle-wall-module={presented.tab}
      data-battle-realtime={realtimeActive && live ? selected.source : "off"}
      tabIndex={0}
      aria-label={`${presented.leftTicker} versus ${presented.rightTicker}, ${stateLabel}`}
      className={`mwz-hud-frame relative isolate min-w-0 max-w-full space-y-3 overflow-hidden p-3 outline-none transition-[box-shadow,border-color] duration-500 md:space-y-4 md:p-5 data-[battle-focused=true]:ring-2 data-[battle-focused=true]:ring-accent/80 data-[battle-focused=true]:shadow-[0_0_28px_rgba(240,106,26,0.28)] motion-reduce:transition-none motion-reduce:shadow-none focus-visible:ring-2 focus-visible:ring-accent ${moduleTone}`}
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <TacticalTag
          label={stateLabel}
          tone={presented.tab === "live" ? "hot" : presented.tab === "upcoming" ? "sponsored" : "default"}
        />
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {presented.classification ? (
            <TacticalTag label={presented.classification} tone={presented.classification === "RANKED" ? "success" : "hot"} />
          ) : null}
          <TacticalTag label={presented.typeLabel} tone="default" />
          <TacticalTag label={battleChainLabel(chainId)} tone="default" />
        </div>
      </div>

      {upcoming ? (
        <div className="space-y-3 py-4 text-center">
          <div className="font-retro text-xs uppercase tracking-[0.28em] text-white/45">Deployment pending</div>
          <div className="font-retro text-2xl text-foreground md:text-3xl">
            {presented.leftTicker} VS {presented.rightTicker}
          </div>
          <div className="text-sm uppercase tracking-[0.16em] text-white/60">
            {presented.stakeNative || "—"} {presented.nativeSymbol || getNativeSymbol(chainId)}
          </div>
          <div className="text-sm uppercase tracking-[0.16em] text-white/60">{battleDurationLabel(presented.durationHours)}</div>
          <TacticalTag label="AWAITING FUNDING" tone="hot" />
        </div>
      ) : (
        <div className="relative isolate overflow-hidden">
          <div className="relative z-10 grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center md:gap-3">
            <BattleWallCombatant
              battle={displayBattle}
              participant={left}
              metricsSide={displayMetrics?.sides?.left}
              pointsLabel={presented.leftPointsLabel}
              scoreCaption={presented.scoreCaption}
              isLeader={presented.leaderIndex === 0}
              accent="ember"
              combatSide="left"
            />
            <BattleWallVs
              leftLabel={presented.leftTicker}
              rightLabel={presented.rightTicker}
              leftPoints={presented.leftPointsLabel}
              rightPoints={presented.rightPointsLabel}
              leaderIndex={presented.leaderIndex}
              gapLabel={presented.gapLabel}
              clockLabel={battleClockLabel(displayBattle)}
              remaining={presented.tab === "live"}
              statusLabel={presented.statusLabel}
              scoreKind={presented.scoreKind}
            />
            <BattleWallCombatant
              battle={displayBattle}
              participant={right}
              metricsSide={displayMetrics?.sides?.right}
              pointsLabel={presented.rightPointsLabel}
              scoreCaption={presented.scoreCaption}
              isLeader={presented.leaderIndex === 1}
              accent="cyan"
              combatSide="right"
            />
          </div>
          {mountEffects ? (
            <BattleCombatEffects metrics={displayMetrics} rootRef={moduleRef} battleId={battle.id} />
          ) : null}
        </div>
      )}

      <div className="relative z-20 flex justify-end">
        <Link
          to={presented.href}
          className="text-xs uppercase tracking-[0.16em] text-white/55 underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Open fight
        </Link>
      </div>
    </article>
  );
}
