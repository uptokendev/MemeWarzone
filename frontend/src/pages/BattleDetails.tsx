import { Link, useParams } from "react-router-dom";
import { BattleCombatEffects } from "@/components/arena/BattleCombatEffects";
import { BattleCombatantCard } from "@/components/arena/BattleCombatantCard";
import { BattleScoreHud } from "@/components/arena/BattleScoreHud";
import { ArenaStakeButton } from "@/components/arena/ArenaStakeButton";
import { ArenaWarPoolClaimButton } from "@/components/arena/ArenaWarPoolClaimButton";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { WarPoolPanel } from "@/components/postgrad/WarPoolPanel";
import { Button } from "@/components/ui/button";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";
import { useArenaBattleRealtimeDetails } from "@/hooks/useArenaBattleRealtimeDetails";
import {
  battleChainLabel,
  battleDurationLabel,
  battleLeaderIndex,
  formatCompactUsd,
} from "@/lib/arena/battlePresentation";
import { isSolanaChainId } from "@/lib/chainConfig";
import { publicBattleLabel, publicBattleLane } from "@/lib/arena/publicBattleState";

function formatMoment(value?: string | null) {
  if (!value) return "Unscheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unscheduled";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function tokenKey(value: unknown, chainId: number) {
  const raw = String(value || "").trim();
  return isSolanaChainId(chainId) ? raw : raw.toLowerCase();
}

const BattleDetails = () => {
  const { id } = useParams();
  const { battle, source, realtimeState, metrics } = useArenaBattleRealtimeDetails(id);

  if (!battle) {
    return (
      <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
        <section className="mwz-hud-frame p-5">
          <h1 className="font-retro text-2xl text-foreground">Battle unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {source === "empty" ? "Battle data is not available right now." : "This battle could not be loaded."}
          </p>
          <div className="mt-4">
            <Button asChild size="sm" variant="outline" className="font-retro">
              <Link to="/warzone/battles">Back to battles</Link>
            </Button>
          </div>
        </section>
      </ContentContainer>
    );
  }

  const battleChainId = Number((battle as { chainId?: number }).chainId || 0);
  const lane = publicBattleLane(battle.state);
  const tournamentId = String((battle as { tournamentId?: string }).tournamentId || "");
  const tournamentMatch = String((battle as { source?: string }).source || "") === "tournament" && Boolean(tournamentId);
  const left = battle.participants[0];
  const right = battle.participants[1];
  const leftRoute = getArenaTokenRoute(left?.tokenAddress ?? left?.tokenId ?? left?.campaignAddress ?? null);
  const rightRoute = getArenaTokenRoute(right?.tokenAddress ?? right?.tokenId ?? right?.campaignAddress ?? null);
  const legacyLeaderIndex = battleLeaderIndex(battle);
  const battlePointsLeaderIndex = metrics?.leaderSide === "left" ? 0 : metrics?.leaderSide === "right" ? 1 : null;
  const cardLeaderIndex = battle.state === "live" && metrics ? battlePointsLeaderIndex : legacyLeaderIndex;
  const matchType = tournamentMatch
    ? "Tournament duel"
    : String((battle as { source?: string }).source || "queue") === "challenge"
      ? "Challenge duel"
      : "Queue duel";
  const winnerToken = String(
    (battle as { winnerToken?: string; moneyWinnerToken?: string }).winnerToken ||
      (battle as { moneyWinnerToken?: string }).moneyWinnerToken ||
      "",
  );
  const winnerKey = tokenKey(winnerToken, battleChainId);
  const winnerLabel = winnerToken
    ? battle.participants.find((participant) =>
        [participant.tokenId, participant.tokenAddress, participant.campaignAddress]
          .some((value) => tokenKey(value, battleChainId) === winnerKey))?.symbol || "Winner declared"
    : battle.state === "finished" && legacyLeaderIndex === 0
      ? left?.symbol || left?.tokenName || "Left"
      : battle.state === "finished" && legacyLeaderIndex === 1
        ? right?.symbol || right?.tokenName || "Right"
        : "Pending settlement";
  const sides = battle.participants
    .filter((participant) => participant.tokenId && !String(participant.tokenId).startsWith("pending-"))
    .map((participant) => ({
      tokenId: String(participant.tokenAddress || participant.tokenId),
      tokenName: participant.tokenName,
      symbol: participant.symbol,
      score: participant.score,
      uniqueTraders: participant.uniqueTraders,
      eligible: true,
    }));
  const metricHealthLabel = !metrics
    ? "Battle telemetry pending"
    : metrics.dataHealth.healthy
      ? "Battle data healthy"
      : "DATA DELAY";
  const realtimeLabel = realtimeState === "connected"
    ? "Realtime linked"
    : realtimeState === "unavailable"
      ? "Realtime unavailable"
      : realtimeState === "disconnected"
        ? "Realtime reconnecting"
        : "Realtime connecting";
  const leftLabel = left?.symbol || left?.tokenName || "Left";
  const rightLabel = right?.symbol || right?.tokenName || "Right";

  return (
    <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
      <section className="relative overflow-hidden border border-white/10 bg-black/30 p-4 md:p-6">
        <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(249,115,22,0.09),transparent_38%,rgba(34,211,238,0.07))]" />
        <div className="relative space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-[0.26em] text-accent/80">Battle theater</div>
              <h1 className="mt-2 font-retro text-3xl text-foreground md:text-4xl">
                {leftLabel} vs {rightLabel}
              </h1>
              <p className="mt-2 max-w-3xl text-sm text-white/62">
                Live Battle Points combine MCAP performance, holder growth, and manipulation-protected battle-period volume from the authoritative Arena market snapshot.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <TacticalTag label={publicBattleLabel(lane, battle.state)} tone={lane === "live" ? "hot" : battle.state === "matched" ? "hot" : "default"} />
              <TacticalTag label={battleChainLabel(battleChainId)} tone="default" />
              <TacticalTag label={matchType} tone={tournamentMatch ? "sponsored" : "default"} />
              <TacticalTag label={source === "api" ? "REST synced" : "Awaiting REST"} tone={source === "api" ? "success" : "default"} />
              <TacticalTag label={metricHealthLabel} tone={metrics?.dataHealth.healthy ? "success" : "default"} />
              <TacticalTag label={realtimeLabel} tone={realtimeState === "connected" ? "success" : "default"} />
            </div>
          </div>

          <div className="relative">
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px_minmax(0,1fr)]">
              <BattleCombatantCard
                battle={battle}
                participant={left}
                metricsSide={metrics?.sides.left}
                sideLabel="Left flank"
                href={leftRoute}
                isLeader={cardLeaderIndex === 0}
                accent="ember"
              />

              <BattleScoreHud
                battle={battle}
                metrics={metrics}
                leftLabel={leftLabel}
                rightLabel={rightLabel}
                realtimeState={realtimeState}
              />

              <BattleCombatantCard
                battle={battle}
                participant={right}
                metricsSide={metrics?.sides.right}
                sideLabel="Right flank"
                href={rightRoute}
                isLeader={cardLeaderIndex === 1}
                accent="cyan"
              />
            </div>
            <BattleCombatEffects metrics={battle.state === "live" ? metrics : null} />
          </div>
        </div>
      </section>

      <WarPoolPanel
        poolSubjectId={tournamentMatch ? tournamentId : battle.id}
        chainId={battleChainId}
        nativeSymbol={(battle as { nativeSymbol?: string }).nativeSymbol}
        sides={sides}
        kind={tournamentMatch ? "tournament" : "battle"}
        redirectTo={
          tournamentMatch
            ? { href: `/warzone/tournament/${encodeURIComponent(tournamentId)}`, label: "Support this coin in the tournament" }
            : null
        }
      />

      <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="mwz-hud-frame space-y-3 p-4 text-sm text-muted-foreground">
          <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">Battle terms</div>
          <p>
            {battle.state === "matched"
              ? isSolanaChainId(battleChainId)
                ? "Settlement is agreed. The first owner pays their SOL stake while opening the pool. The rival then deposits the same stake. The fight clock starts only when both have paid."
                : "Settlement is agreed. Open the pool, then both owners deposit the same stake. The fight clock starts only when both have paid. If the other owner never deposits, refund after the pay window."
              : "Agree stake and fight length first. The clock starts only once the fight is fully funded and marked live."}
          </p>
          <p>
            Support is a donation into the battle treasury for the memecoins in the fight, not betting and not charity. Supporters are not paid. Winner-takes-all: 85% winning campaign owner, 5% protocol, 10% Major War League.
          </p>
          <div className="grid gap-2 border-t border-white/10 pt-3 text-xs text-white/58 sm:grid-cols-2">
            <div>
              <span className="text-white/38">Stake:</span>{" "}
              {Number((battle as { stakeNative?: number }).stakeNative || 0).toFixed(2)} {(battle as { nativeSymbol?: string }).nativeSymbol || "BNB"}
            </div>
            <div>
              <span className="text-white/38">Fight length:</span>{" "}
              {battleDurationLabel((battle as { durationHours?: number }).durationHours)}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 pt-2">
            {battle.state === "matched" ? (
              <ArenaStakeButton
                battleId={battle.id}
                chainId={battleChainId}
                battleState={battle.state}
              />
            ) : null}
            {battle.state === "finished" && !tournamentMatch ? (
              <ArenaWarPoolClaimButton battleId={battle.id} chainId={battleChainId} />
            ) : null}
          </div>
        </div>

        <div className="mwz-hud-frame space-y-4 p-4">
          <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">Result log</div>
          <div className="space-y-3 text-sm text-white/78">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <span className="text-white/48">Settlement winner</span>
              <span className="font-medium text-white">{winnerLabel}</span>
            </div>
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <span className="text-white/48">Settlement engine</span>
              <span className="font-medium text-white">V1 MCAP % change</span>
            </div>
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <span className="text-white/48">Live telemetry</span>
              <span className="font-medium text-white">Battle Points V2</span>
            </div>
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <span className="text-white/48">Started</span>
              <span className="font-medium text-white">{formatMoment(battle.startedAt)}</span>
            </div>
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <span className="text-white/48">Ends</span>
              <span className="font-medium text-white">{formatMoment(battle.endsAt)}</span>
            </div>
            <div className="flex items-center justify-between pb-1">
              <span className="text-white/48">Combined current MCAP</span>
              <span className="font-medium text-white">{formatCompactUsd((left?.marketCapUsd || 0) + (right?.marketCapUsd || 0))}</span>
            </div>
          </div>
        </div>
      </section>

      <Button asChild size="sm" variant="outline" className="font-retro">
        <Link to="/warzone/battles">Back to battles</Link>
      </Button>
    </ContentContainer>
  );
};

export default BattleDetails;
