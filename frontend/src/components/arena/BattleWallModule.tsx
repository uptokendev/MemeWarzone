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

  return (
    <article
      ref={moduleRef}
      id={battleDomId(battle.id)}
      data-battle-id={battle.id}
      data-battle-wall-module={presented.tab}
      data-battle-realtime={realtimeActive && live ? selected.source : "off"}
      tabIndex={0}
      className="mwz-hud-frame relative space-y-4 overflow-hidden p-4 outline-none transition-[box-shadow] duration-500 md:p-5 data-[battle-focused=true]:ring-2 data-[battle-focused=true]:ring-accent motion-reduce:transition-none"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <TacticalTag
            label={presented.tab === "live" ? "LIVE" : presented.tab === "upcoming" ? "DEPLOYMENT PENDING" : "FINISHED"}
            tone={presented.tab === "live" ? "hot" : presented.tab === "upcoming" ? "sponsored" : "default"}
          />
          {presented.classification ? (
            <TacticalTag label={presented.classification} tone={presented.classification === "RANKED" ? "success" : "hot"} />
          ) : null}
          <TacticalTag label={presented.typeLabel} tone="default" />
          <TacticalTag label={battleChainLabel(chainId)} tone="default" />
        </div>
        {presented.tab === "live" ? (
          <div className="text-[11px] uppercase tracking-[0.16em] text-white/50">{battleClockLabel(displayBattle)}</div>
        ) : null}
      </div>

      {upcoming ? (
        <div className="space-y-3 text-center">
          <div className="font-retro text-2xl text-foreground">
            {presented.leftTicker} VS {presented.rightTicker}
          </div>
          <div className="text-sm uppercase tracking-[0.16em] text-white/60">
            {presented.stakeNative || "—"} {presented.nativeSymbol || getNativeSymbol(chainId)}
          </div>
          <div className="text-sm uppercase tracking-[0.16em] text-white/60">{battleDurationLabel(presented.durationHours)}</div>
          <TacticalTag label="AWAITING FUNDING" tone="hot" />
        </div>
      ) : (
        <div className="relative">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center">
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
              clockLabel={presented.tab === "live" ? `${battleClockLabel(displayBattle)} remaining` : battleClockLabel(displayBattle)}
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

      <div className="flex justify-end">
        <Link to={presented.href} className="text-xs uppercase tracking-[0.16em] text-white/55 hover:text-accent">
          Open fight
        </Link>
      </div>
    </article>
  );
}
