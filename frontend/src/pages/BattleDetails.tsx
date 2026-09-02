import { Clock3, Coins, Crown, Shield, Swords } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { TacticalTag } from "@/components/postgrad/PostGradPrimitives";
import { BattleCombatantCard } from "@/components/arena/BattleCombatantCard";
import { Button } from "@/components/ui/button";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { getArenaTokenRoute } from "@/features/postgrad/tokenRoutes";
import { useArenaBattleDetails } from "@/hooks/useArenaBattleFeed";
import { ArenaStakeButton } from "@/components/arena/ArenaStakeButton";
import { ArenaWarPoolClaimButton } from "@/components/arena/ArenaWarPoolClaimButton";
import { WarPoolPanel } from "@/components/postgrad/WarPoolPanel";
import {
  battleChainLabel,
  battleClockLabel,
  battleDurationLabel,
  battleLeaderIndex,
  battlePointGap,
  battleScoreLabel,
  battleScoreShare,
  formatCompactUsd,
} from "@/lib/arena/battlePresentation";
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

const BattleDetails = () => {
  const { id } = useParams();
  const { battle, source } = useArenaBattleDetails(id);

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

  const lane = publicBattleLane(battle.state);
  const tournamentId = String((battle as { tournamentId?: string }).tournamentId || "");
  const tournamentMatch = String((battle as { source?: string }).source || "") === "tournament" && Boolean(tournamentId);
  const left = battle.participants[0];
  const right = battle.participants[1];
  const leftRoute = getArenaTokenRoute(left?.tokenAddress ?? left?.tokenId ?? left?.campaignAddress ?? null);
  const rightRoute = getArenaTokenRoute(right?.tokenAddress ?? right?.tokenId ?? right?.campaignAddress ?? null);
  const leaderIndex = battleLeaderIndex(battle);
  const scoreLabel = battleScoreLabel(battle);
  const scoreGap = battlePointGap(battle);
  const leftShare = battleScoreShare(left, battle);
  const rightShare = Math.max(0, 100 - leftShare);
  const matchType = tournamentMatch ? "Tournament duel" : String((battle as { source?: string }).source || "queue") === "challenge" ? "Challenge duel" : "Queue duel";
  const winnerToken = String((battle as { winnerToken?: string; moneyWinnerToken?: string }).winnerToken || (battle as { moneyWinnerToken?: string }).moneyWinnerToken || "");
  const winnerLabel = winnerToken
    ? battle.participants.find((participant) => [participant.tokenId, participant.tokenAddress, participant.campaignAddress].map((value) => String(value || "").toLowerCase()).includes(winnerToken.toLowerCase()))?.symbol || "Winner declared"
    : leaderIndex === 0
      ? left?.symbol || left?.tokenName || "Left"
      : leaderIndex === 1
        ? right?.symbol || right?.tokenName || "Right"
        : "No winner yet";
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

  return (
    <ContentContainer className="space-y-5 px-1 pb-10 pt-4">
      <section className="relative overflow-hidden border border-white/10 bg-black/30 p-4 md:p-6">
        <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(249,115,22,0.09),transparent_38%,rgba(34,211,238,0.07))]" />
        <div className="relative space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-[0.26em] text-accent/80">Battle theater</div>
              <h1 className="mt-2 font-retro text-3xl text-foreground md:text-4xl">
                {left?.symbol || left?.tokenName || "Coin"} vs {right?.symbol || right?.tokenName || "Awaiting rival"}
              </h1>
              <p className="mt-2 max-w-3xl text-sm text-white/62">
                The detail screen now tracks momentum, control, and battle readiness from the same Arena feed that powers Command Center and WarPool.
              </p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <TacticalTag label={publicBattleLabel(lane, battle.state)} tone={lane === "live" ? "hot" : battle.state === "matched" ? "hot" : "default"} />
              <TacticalTag label={battleChainLabel((battle as { chainId?: number }).chainId)} tone="default" />
              <TacticalTag label={matchType} tone={tournamentMatch ? "sponsored" : "default"} />
              <TacticalTag label={source === "api" ? "Live data" : "Awaiting data"} tone={source === "api" ? "success" : "default"} />
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.15fr_340px_1.15fr]">
            <BattleCombatantCard battle={battle} participant={left} sideLabel="Left flank" href={leftRoute} isLeader={leaderIndex === 0} accent="ember" />

            <section className="mwz-hud-frame flex flex-col justify-between gap-4 p-4 md:p-5">
              <div>
                <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">Central HUD</div>
                <div className="mt-2 flex items-center justify-center gap-3 font-retro text-3xl text-foreground md:text-4xl">
                  <span>{left?.score.toFixed(1)}</span>
                  <Swords className="h-5 w-5 text-white/35" />
                  <span>{right?.score.toFixed(1)}</span>
                </div>
                <div className="mt-2 text-center text-xs uppercase tracking-[0.22em] text-white/55">{scoreLabel}</div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs text-white/60">
                  <span>{left?.symbol || "Left"}</span>
                  <span>{right?.symbol || "Right"}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-white/10">
                  <div className="flex h-full w-full">
                    <div className="bg-orange-400/80" style={{ width: `${leftShare}%` }} />
                    <div className="bg-cyan-400/80" style={{ width: `${rightShare}%` }} />
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs text-white/55">
                  <span>{leaderIndex === null ? "Dead even" : `${leaderIndex === 0 ? left?.symbol : right?.symbol} controlling`}</span>
                  <span>{scoreGap > 0 ? `Gap ${scoreGap.toFixed(1)}` : "Gap 0.0"}</span>
                </div>
              </div>

              <div className="grid gap-3 text-sm text-white/76">
                <div className="flex items-center gap-2 border-b border-white/10 pb-3">
                  <Clock3 className="h-4 w-4 text-white/50" />
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Clock</div>
                    <div>{battleClockLabel(battle)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 border-b border-white/10 pb-3">
                  <Coins className="h-4 w-4 text-white/50" />
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Stake</div>
                    <div>{Number((battle as { stakeNative?: number }).stakeNative || 0).toFixed(2)} {(battle as { nativeSymbol?: string }).nativeSymbol || "BNB"}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 border-b border-white/10 pb-3">
                  <Shield className="h-4 w-4 text-white/50" />
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Duration</div>
                    <div>{battleDurationLabel((battle as { durationHours?: number }).durationHours)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Crown className="h-4 w-4 text-white/50" />
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.22em] text-white/40">Advantage</div>
                    <div>{winnerLabel}</div>
                  </div>
                </div>
              </div>
            </section>

            <BattleCombatantCard battle={battle} participant={right} sideLabel="Right flank" href={rightRoute} isLeader={leaderIndex === 1} accent="cyan" />
          </div>
        </div>
      </section>

      <WarPoolPanel
        poolSubjectId={tournamentMatch ? tournamentId : battle.id}
        chainId={(battle as { chainId?: number }).chainId}
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
              ? Number((battle as { chainId?: number }).chainId) === 101 || Number((battle as { chainId?: number }).chainId) === 102
                ? "Settlement is agreed. The first owner pays their SOL stake while opening the pool. The rival then deposits the same stake. The fight clock starts only when both have paid."
                : "Settlement is agreed. Open the pool, then both owners deposit the same stake. The fight clock starts only when both have paid. If the other owner never deposits, refund after the pay window."
              : "Agree stake and fight length first. The clock starts only once the fight is fully funded and marked live."}
          </p>
          <p>
            Support is a donation into the battle treasury for the memecoins in the fight, not betting and not charity. Supporters are not paid. Winner-takes-all: 85% winning campaign owner, 5% protocol, 10% Major War League.
          </p>
          <div className="flex flex-wrap gap-2 pt-2">
            {battle.state === "matched" ? (
              <ArenaStakeButton
                battleId={battle.id}
                chainId={(battle as { chainId?: number }).chainId}
                battleState={battle.state}
              />
            ) : null}
            {battle.state === "finished" && !tournamentMatch ? (
              <ArenaWarPoolClaimButton battleId={battle.id} chainId={(battle as { chainId?: number }).chainId} />
            ) : null}
          </div>
        </div>

        <div className="mwz-hud-frame space-y-4 p-4">
          <div className="text-[10px] uppercase tracking-[0.24em] text-white/45">Result log</div>
          <div className="space-y-3 text-sm text-white/78">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <span className="text-white/48">Winner</span>
              <span className="font-medium text-white">{winnerLabel}</span>
            </div>
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <span className="text-white/48">Match source</span>
              <span className="font-medium text-white">{matchType}</span>
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
              <span className="text-white/48">Current MCAP</span>
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
