import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BattleCombatEffects } from "@/components/arena/BattleCombatEffects";
import { BattleShareMenu } from "@/components/arena/BattleShareMenu";
import { BattleWallCombatant } from "@/components/arena/BattleWallCombatant";
import { BattleWallMore } from "@/components/arena/BattleWallMore";
import { BattleWallVs } from "@/components/arena/BattleWallVs";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { useBattleWallRealtime } from "@/hooks/useBattleWallRealtime";
import { useBattleWallViewport, type BattleWallViewportReport } from "@/hooks/useBattleWallViewport";
import { battleChainLabel, battleClockLabel, battleDurationLabel } from "@/lib/arena/battlePresentation";
import { battleMorePanelId, battleMoreToggle } from "@/lib/arena/battleWallMorePresentation.mjs";
import { DATA_DELAY_LABEL, battleDomId, presentBattleWallFightBand, presentBattleWallModule } from "@/lib/arena/battleWallPresentation.mjs";
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

  const delay = presented.scoreKind === "delay" || presented.statusLabel === DATA_DELAY_LABEL;
  const leaderReady = !upcoming && !delay && (presented.leaderIndex === 0 || presented.leaderIndex === 1);
  const band = presentBattleWallFightBand(presented, {
    chainLabel: battleChainLabel(chainId),
    clockLabel: upcoming ? null : battleClockLabel(displayBattle),
  });
  const stateLabel = band.stateLabel;

  return (
    <article
      ref={moduleRef}
      id={battleDomId(battle.id)}
      data-battle-id={battle.id}
      data-battle-wall-module={presented.tab}
      data-battle-realtime={realtimeActive && live ? selected.source : "off"}
      data-battle-wall-open="true"
      tabIndex={0}
      aria-label={`${presented.leftTicker} versus ${presented.rightTicker}, ${stateLabel}`}
      className="relative isolate min-w-0 max-w-full bg-transparent py-4 outline-none motion-reduce:transition-none motion-reduce:shadow-none focus-visible:ring-2 focus-visible:ring-accent data-[battle-focused=true]:ring-2 data-[battle-focused=true]:ring-accent/80"
    >
      <div
        data-battle-wall-status-band="true"
        className="relative z-20 mb-3 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b pb-2.5 text-[10px] uppercase tracking-[0.16em] text-white/55"
        style={{ borderColor: "var(--mwz-flat-card-border)" }}
      >
        <span className={presented.tab === "live" ? "font-retro text-xs text-orange-200" : "font-retro text-xs text-white/80"}>
          {band.stateLabel}
        </span>
        <span className="text-white/20" aria-hidden="true">|</span>
        <span className="font-retro text-[11px] text-white/88">{band.matchup}</span>
        {band.classification ? (
          <>
            <span className="text-white/20" aria-hidden="true">|</span>
            <span>{band.classification}</span>
          </>
        ) : null}
        <span className="text-white/20" aria-hidden="true">|</span>
        <span>{band.typeLabel}</span>
        {band.chainLabel ? (
          <>
            <span className="text-white/20" aria-hidden="true">|</span>
            <span>{band.chainLabel}</span>
          </>
        ) : null}
        {band.clockLabel ? (
          <>
            <span className="text-white/20" aria-hidden="true">|</span>
            <span className="text-white/75">{band.clockLabel}</span>
          </>
        ) : null}
      </div>

      <div className="relative isolate overflow-hidden" data-battle-wall-combat-stage="true">
        <div className="relative z-10 grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-start md:gap-2">
          <BattleWallCombatant
            battle={displayBattle}
            participant={left}
            metricsSide={displayMetrics?.sides?.left}
            pointsLabel={upcoming ? null : presented.leftPointsLabel}
            scoreCaption={upcoming ? null : presented.scoreCaption}
            isLeader={leaderReady && presented.leaderIndex === 0}
            isTrailer={leaderReady && presented.leaderIndex === 1}
            finished={presented.tab === "finished"}
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
            isLeader={leaderReady && presented.leaderIndex === 1}
            isTrailer={leaderReady && presented.leaderIndex === 0}
            finished={presented.tab === "finished"}
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
        className="relative z-20 mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2 border-t pt-2.5"
        style={{ borderColor: "var(--mwz-flat-card-border)" }}
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
            className="min-h-11 text-xs uppercase tracking-[0.16em] text-white/55 underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {moreToggle.label}
          </button>
          <Link
            to={presented.href}
            className="min-h-11 inline-flex items-center text-xs uppercase tracking-[0.16em] text-white/40 underline-offset-4 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
