import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";
import { BattleCombatEffects } from "@/components/arena/BattleCombatEffects";
import { BattleVoteImpacts } from "@/components/arena/BattleVoteImpacts";
import { BattleFightActions } from "@/components/arena/BattleFightActions";
import { BattleShareMenu } from "@/components/arena/BattleShareMenu";
import { BattleWallCombatant } from "@/components/arena/BattleWallCombatant";
import { BattleWallVs } from "@/components/arena/BattleWallVs";
import type { Battle } from "@/features/postgrad/contracts";
import { postGradFlags } from "@/features/postgrad/config";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { useBattleWallRealtime } from "@/hooks/useBattleWallRealtime";
import { useBattleWallViewport, type BattleWallViewportReport } from "@/hooks/useBattleWallViewport";
import { battleChainLabel, battleClockLabel, battleDurationLabel } from "@/lib/arena/battlePresentation";
import { BattleWallCombatControls, battleVoteEligibility, liveVoteScore } from "@/components/arena/BattleWallCombatControls";
import { useBattleVote } from "@/components/arena/BattleVoteControls";
import { ArenaWarPoolClaimButton } from "@/components/arena/ArenaWarPoolClaimButton";
import { formatPrizePool, useBattlePrizePool } from "@/components/arena/useBattlePrizePool";
import { presentBattleGeneration } from "@/lib/arena/battleGenerationPresentation.mjs";
import { battleWinnerIndex, presentBattleWallMore } from "@/lib/arena/battleWallMorePresentation.mjs";
import { requestArenaBuyIn } from "@/lib/arena/challengePopupPresentation.mjs";
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
  showBuyIn?: boolean;
  /** Artboard frame: list card, featured hero (first live battle) or the battle page banner. */
  variant?: "list" | "hero" | "page";
};

/** Info band separator: "·" in the phone's single swipe line, "|" on wider screens. */
function BandSep() {
  return (
    <span aria-hidden="true" className="text-[#3A424C]">
      <span className="lg:hidden">·</span>
      <span className="hidden lg:inline">|</span>
    </span>
  );
}

const SMALL_BUTTON =
  "mw-focus inline-flex min-h-9 items-center gap-2 rounded-[10px] border border-mw-edge bg-mw-raised px-3 font-mw-body text-sm font-semibold normal-case tracking-normal text-mw-text hover:bg-[#222830] hover:text-mw-text";

export function BattleWallModule({
  battle,
  metrics,
  metricsRequested = false,
  metricsLoaded = false,
  realtimeActive = false,
  viewportIndex = 0,
  onViewportReport,
  showBuyIn = false,
  variant = "list",
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
  const basePresented = presentBattleWallModule(displayBattle, displayMetrics, {
    requested: selected.requested,
    loaded: selected.loaded,
  });
  const chainId = Number((displayBattle as Battle & { chainId?: number }).chainId || 0);
  // Standalone Vote Battles: the battle record carries no vote totals (only tournaments fill
  // participants[].voteScore), so the card showed "VOTES —" while votes were being cast. The card and
  // its Vote/Boost buttons share one live vote state (regulation points: Free Vote 1, Boost 2).
  const voteEligibility = battleVoteEligibility(displayBattle);
  const voteState = useBattleVote({ battleId: voteEligibility.showScore ? battle.id : "", chainId });
  const presented = voteEligibility.showScore && voteState.payload
    ? { ...basePresented, ...liveVoteScore(voteState.model.leftPoints, voteState.model.rightPoints) }
    : basePresented;
  // Live prize pool in the status band; the winner's claim sits on the card (the MORE panel is gone).
  const typedBattle = displayBattle as Battle & { source?: string; state?: string; stakeNative?: number };
  const prizePoolEnabled =
    typedBattle.source !== "tournament" &&
    Number(typedBattle.stakeNative || 0) > 0 &&
    (basePresented.phase === "live" || basePresented.tab === "finished" || typedBattle.state === "live");
  const prizePool = useBattlePrizePool(battle.id, chainId, prizePoolEnabled);
  const claimInfo = presentBattleWallMore(displayBattle, displayMetrics, { realtimeState: realtime.realtimeState, dataSource: selected.source });
  const showClaim = Boolean(claimInfo.showClaim) && Boolean(presentBattleGeneration(displayBattle, displayMetrics || {}).pool);
  const phase = presented.phase;
  const preLive = phase === "challenged" || phase === "matched";
  const challenged = phase === "challenged";
  const left = displayBattle.participants?.[0];
  const right = displayBattle.participants?.[1];
  const mountEffects = shouldMountWallCombatEffects({
    live,
    realtimeActive,
    snapshotReady: realtime.snapshotReady,
  });

  const delay = presented.scoreKind === "delay" || presented.statusLabel === DATA_DELAY_LABEL;
  const leaderReady = !preLive && !delay && (presented.leaderIndex === 0 || presented.leaderIndex === 1);
  // Finished: the settled winner's card gets the green border (founder, 2026-09-26).
  const winnerIndex = presented.tab === "finished" ? battleWinnerIndex(displayBattle) : null;
  const band = presentBattleWallFightBand(presented, {
    chainLabel: battleChainLabel(chainId),
    clockLabel: preLive ? null : battleClockLabel(displayBattle),
    battle: displayBattle,
  });
  const stateLabel = band.stateLabel;
  const fightMode = presented.fightMode?.key || null;

  return (
    <article
      ref={moduleRef}
      id={battleDomId(battle.id)}
      data-battle-id={battle.id}
      data-battle-wall-module={presented.tab}
      data-battle-phase={phase || ""}
      data-battle-realtime={realtimeActive && live ? selected.source : "off"}
      data-battle-wall-open="true"
      tabIndex={0}
      aria-label={`${presented.leftTicker} versus ${presented.rightTicker}, ${stateLabel}`}
      className={cn(
        "relative isolate flex min-w-0 max-w-full flex-col overflow-hidden font-mw-body text-mw-text outline-none motion-reduce:transition-none motion-reduce:shadow-none focus-visible:ring-2 focus-visible:ring-mw-accent data-[battle-focused=true]:ring-2 data-[battle-focused=true]:ring-mw-accent",
        variant === "list"
          ? "mw-banner-sm gap-3 rounded-2xl border border-[#2A3038] p-3 lg:gap-3 lg:rounded-[14px] lg:border-mw-border lg:bg-mw-surface lg:p-3.5"
          : "mw-banner gap-3.5 rounded-2xl border border-[#2A3038] p-3 lg:rounded-[18px] lg:p-[18px]",
      )}
    >
      <div
        data-battle-wall-status-band="true"
        className="relative z-20 flex min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted [scrollbar-width:none] lg:flex-wrap lg:gap-2.5 lg:overflow-visible lg:whitespace-normal lg:text-[13px] [&::-webkit-scrollbar]:hidden"
      >
        <span className={presented.tab === "live" || challenged ? "text-[#FF9A4D]" : "text-mw-text"}>
          {band.stateLabel}
        </span>
        <BandSep />
        <span className="text-mw-text">{band.matchup}</span>
        {band.classification ? (
          <>
            <BandSep />
            <span>{band.classification}</span>
          </>
        ) : null}
        <BandSep />
        <span>{band.typeLabel}</span>
        {band.chainLabel ? (
          <>
            <BandSep />
            <span>{band.chainLabel}</span>
          </>
        ) : null}
        {band.clockLabel ? (
          <>
            <BandSep />
            <span>{band.clockLabel}</span>
          </>
        ) : null}
        {band.modeLabel ? (
          <>
            <BandSep />
            <span data-battle-mode-label={presented.fightMode?.key}>{band.modeLabel}</span>
          </>
        ) : null}
        {prizePool ? (
          <>
            <BandSep />
            <span data-battle-prize-pool="true" className="text-[#F2C14E]">
              Prize pool {formatPrizePool(prizePool)}
            </span>
          </>
        ) : null}
      </div>

      {presented.cardTitle ? (
        <h2
          data-battle-wall-card-title={phase}
          className="relative z-20 m-0 font-mw-cond text-lg font-bold tracking-[0.02em] text-mw-accent-soft"
        >
          {presented.cardTitle}
        </h2>
      ) : null}

      <BattleWallCombatControls
        voteState={voteState}
        battle={displayBattle}
        metrics={displayMetrics}
        realtimeState={realtime.realtimeState}
        dataSource={selected.source}
      >
        {(combat) => (
          <>
            <div className="relative isolate overflow-hidden" data-battle-wall-combat-stage="true">
              <div className="relative z-10 grid min-w-0 grid-cols-1 items-stretch gap-2.5 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-center lg:gap-3">
                <BattleWallCombatant
                  battle={displayBattle}
                  participant={left}
                  metricsSide={displayMetrics?.sides?.left}
                  pointsLabel={preLive ? null : presented.leftPointsLabel}
                  scoreCaption={preLive ? null : presented.scoreCaption}
                  isLeader={leaderReady && presented.leaderIndex === 0}
                  isTrailer={leaderReady && presented.leaderIndex === 1}
                  finished={presented.tab === "finished"}
                  isWinner={winnerIndex === 0}
                  accent="ember"
                  combatSide="left"
                  variant={variant}
                  actions={
                    combat.left ??
                    (presented.showFightActions ? (
                      <BattleFightActions mode={fightMode} mocksEnabled={postGradFlags.mocks} />
                    ) : null)
                  }
                />
                <BattleWallVs
                  leftLabel={presented.leftTicker}
                  rightLabel={presented.rightTicker}
                  leftPoints={preLive ? null : presented.leftPointsLabel}
                  rightPoints={preLive ? null : presented.rightPointsLabel}
                  leaderIndex={preLive ? null : presented.leaderIndex}
                  gapLabel={preLive ? null : presented.gapLabel}
                  clockLabel={preLive ? null : battleClockLabel(displayBattle)}
                  endsAt={preLive ? null : displayBattle.endsAt || null}
                  remaining={presented.tab === "live"}
                  statusLabel={preLive ? null : presented.statusLabel}
                  scoreKind={preLive ? null : presented.scoreKind}
                  deploymentPending={phase === "matched"}
                  stakeLabel={
                    phase === "matched"
                      ? `${presented.stakeNative} ${presented.nativeSymbol || getNativeSymbol(chainId)}`.trim()
                      : null
                  }
                  durationLabel={phase === "matched" ? battleDurationLabel(presented.durationHours) : null}
                />
                <BattleWallCombatant
                  battle={displayBattle}
                  participant={right}
                  metricsSide={displayMetrics?.sides?.right}
                  pointsLabel={preLive ? null : presented.rightPointsLabel}
                  scoreCaption={preLive ? null : presented.scoreCaption}
                  isLeader={leaderReady && presented.leaderIndex === 1}
                  isTrailer={leaderReady && presented.leaderIndex === 0}
                  finished={presented.tab === "finished"}
                  isWinner={winnerIndex === 1}
                  accent="cyan"
                  combatSide="right"
                  variant={variant}
                  actions={
                    combat.right ??
                    (presented.showFightActions ? (
                      <BattleFightActions mode={fightMode} mocksEnabled={postGradFlags.mocks} />
                    ) : null)
                  }
                />
              </div>
              {mountEffects ? (
                <BattleCombatEffects metrics={displayMetrics} rootRef={moduleRef} battleId={battle.id} />
              ) : null}
              <BattleVoteImpacts
                active={voteEligibility.showVote && Boolean(voteState.payload)}
                leftPoints={voteState.payload ? voteState.model.leftPoints : null}
                rightPoints={voteState.payload ? voteState.model.rightPoints : null}
                rootRef={moduleRef}
              />
            </div>
            {combat.note}
          </>
        )}
      </BattleWallCombatControls>


      <div
        data-battle-wall-actions="true"
        className="relative z-20 flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-[#1E2329] pt-2.5"
      >
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2" data-battle-wall-actions-reserved="true">
          <BattleShareMenu
            battle={displayBattle}
            metrics={displayMetrics}
            metricsRequested={selected.requested}
            metricsLoaded={selected.loaded}
            votes={voteEligibility.showScore && voteState.payload ? { leftPoints: voteState.model.leftPoints, rightPoints: voteState.model.rightPoints } : null}
          />
          {showBuyIn ? (
            <button
              type="button"
              data-battle-pay-buy-in={battle.id}
              className="mw-focus inline-flex min-h-9 items-center rounded-[10px] border border-mw-accent bg-mw-accent px-3 text-sm font-semibold text-[#140A02] hover:bg-[#FF8F3D]"
              onClick={() => requestArenaBuyIn(displayBattle)}
            >
              Pay buy-in
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {showClaim ? <ArenaWarPoolClaimButton battleId={battle.id} chainId={chainId} className={SMALL_BUTTON} /> : null}
          <Link
            to={presented.href}
            className={SMALL_BUTTON}
          >
            Open fight
          </Link>
        </div>
      </div>

    </article>
  );
}
