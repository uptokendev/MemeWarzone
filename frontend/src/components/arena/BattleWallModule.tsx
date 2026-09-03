import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BattleCombatEffects } from "@/components/arena/BattleCombatEffects";
import { BattleShareMenu } from "@/components/arena/BattleShareMenu";
import { BattleWallCombatant } from "@/components/arena/BattleWallCombatant";
import { BattleWallMore } from "@/components/arena/BattleWallMore";
import { BattleWallVs } from "@/components/arena/BattleWallVs";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { useBattleWallRealtime } from "@/hooks/useBattleWallRealtime";
import { useBattleWallViewport, type BattleWallViewportReport } from "@/hooks/useBattleWallViewport";
import { battleChainLabel, battleClockLabel, battleDurationLabel } from "@/lib/arena/battlePresentation";
import { battleMorePanelId, battleMoreToggle } from "@/lib/arena/battleWallMorePresentation.mjs";
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
  const [moreOpen, setMoreOpen] = useState(false);
  const report = onViewportReport || noopViewportReport;
  const moreToggle = battleMoreToggle(moreOpen);
  const morePanelId = battleMorePanelId(battle.id);

  useEffect(() => {
    setMoreOpen(false);
  }, [battle.id]);

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
      ? "border-orange-400/25"
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
      className={`mwz-hud-frame relative isolate min-w-0 max-w-full overflow-hidden p-3 outline-none transition-[box-shadow,border-color] duration-500 md:p-5 data-[battle-focused=true]:ring-2 data-[battle-focused=true]:ring-accent/80 data-[battle-focused=true]:shadow-[0_0_28px_rgba(240,106,26,0.28)] motion-reduce:transition-none motion-reduce:shadow-none focus-visible:ring-2 focus-visible:ring-accent ${moduleTone}`}
    >
      <div className="relative z-20 mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2 md:mb-4">
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

      <div className="relative isolate overflow-hidden">
        <div className="relative z-10 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(10.5rem,14.5rem)_minmax(0,1fr)] md:items-stretch md:gap-4">
          <BattleWallCombatant
            battle={displayBattle}
            participant={left}
            metricsSide={displayMetrics?.sides?.left}
            pointsLabel={upcoming ? null : presented.leftPointsLabel}
            scoreCaption={upcoming ? null : presented.scoreCaption}
            isLeader={!upcoming && presented.leaderIndex === 0}
            accent="ember"
            combatSide="left"
          />
          <BattleWallVs
            leftLabel={presented.leftTicker}
            rightLabel={presented.rightTicker}
            leftPoints={upcoming ? null : presented.leftPointsLabel}
            rightPoints={upcoming ? null : presented.rightPointsLabel}
            leaderIndex={upcoming ? null : presented.leaderIndex}
            gapLabel={upcoming ? null : presented.gapLabel}
            clockLabel={upcoming ? null : battleClockLabel(displayBattle)}
            remaining={presented.tab === "live"}
            statusLabel={upcoming ? null : presented.statusLabel}
            scoreKind={upcoming ? null : presented.scoreKind}
            deploymentPending={upcoming}
            stakeLabel={
              upcoming
                ? `${presented.stakeNative} ${presented.nativeSymbol || getNativeSymbol(chainId)}`.trim()
                : null
            }
            durationLabel={upcoming ? battleDurationLabel(presented.durationHours) : null}
          />
          <BattleWallCombatant
            battle={displayBattle}
            participant={right}
            metricsSide={displayMetrics?.sides?.right}
            pointsLabel={upcoming ? null : presented.rightPointsLabel}
            scoreCaption={upcoming ? null : presented.scoreCaption}
            isLeader={!upcoming && presented.leaderIndex === 1}
            accent="cyan"
            combatSide="right"
          />
        </div>
        {mountEffects ? (
          <BattleCombatEffects metrics={displayMetrics} rootRef={moduleRef} battleId={battle.id} />
        ) : null}
      </div>

      <div
        data-battle-wall-actions="true"
        className="relative z-20 mt-4 flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3"
      >
        <div className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-2" data-battle-wall-actions-reserved="true">
          <BattleShareMenu
            battle={displayBattle}
            metrics={displayMetrics}
            metricsRequested={selected.requested}
            metricsLoaded={selected.loaded}
          />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            aria-expanded={moreToggle.expanded}
            aria-controls={morePanelId}
            data-battle-more-toggle={battle.id}
            onClick={() => setMoreOpen((open) => !open)}
            className="text-xs uppercase tracking-[0.16em] text-white/55 underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {moreToggle.label}
          </button>
          <Link
            to={presented.href}
            className="text-xs uppercase tracking-[0.16em] text-white/55 underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Open fight
          </Link>
        </div>
      </div>

      <div
        id={morePanelId}
        hidden={!moreToggle.expanded}
        data-battle-more={battle.id}
        data-battle-more-open={moreToggle.expanded ? "true" : "false"}
        className="relative z-20"
      >
        {moreToggle.expanded ? (
          <div className="mt-3 border-t border-white/10 pt-4">
            <BattleWallMore
              battle={displayBattle}
              metrics={displayMetrics}
              realtimeState={realtime.realtimeState}
              dataSource={selected.source}
            />
          </div>
        ) : null}
      </div>
    </article>
  );
}
