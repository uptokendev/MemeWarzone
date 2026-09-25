import { ThumbsUp, Zap } from "lucide-react";

import { boostPaymentLabel, useBattleBoost } from "@/components/arena/BattleBoostPanel";
import type { useBattleVote } from "@/components/arena/BattleVoteControls";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { battleBoostAvailability } from "@/lib/arena/battleBoostPresentation.mjs";
import { presentBattleWallMore } from "@/lib/arena/battleWallMorePresentation.mjs";

type VoteState = ReturnType<typeof useBattleVote>;

type Props = {
  battle: Battle;
  /** Owned by the battle card so its VOTES box and these buttons read one live vote state. */
  voteState: VoteState;
  metrics?: BattleRealtimeMetrics | null;
  realtimeState?: string | null;
  dataSource?: string | null;
};

type SideKey = "left" | "right";

const VOTE_CLASS =
  "flex min-h-12 w-full items-center justify-center gap-2 border border-orange-400/70 bg-gradient-to-b from-orange-500 to-orange-700 px-4 font-retro text-sm uppercase tracking-[0.18em] text-white shadow-[0_0_18px_rgba(249,115,22,0.35)] transition hover:from-orange-400 hover:to-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-45";
const BOOST_CLASS =
  "flex min-h-12 w-full items-center justify-center gap-2 border border-amber-300/60 bg-gradient-to-b from-amber-500 to-amber-800 px-4 font-retro text-sm uppercase tracking-[0.18em] text-black shadow-[0_0_18px_rgba(245,158,11,0.3)] transition hover:from-amber-400 hover:to-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 disabled:cursor-not-allowed disabled:opacity-45";

/**
 * Vote and Boost buttons under each combatant on the battle card. They used to sit in the collapsed
 * "MORE" panel, so a live Vote Battle showed no way to vote or boost (2026-09-25). One click = one
 * Free Vote, or one $1 Boost; the signing, quoting and payment paths are the shared hooks the
 * panels use. Visibility rules are unchanged: vote on live non-tournament Vote Battles, boost when
 * battleBoostAvailability allows it.
 */
/** Which live battles get Free Vote controls (unchanged from the former MORE panel rule). */
export function battleVoteEligibility(battle: Battle) {
  const chainId = Number((battle as Battle & { chainId?: number }).chainId || 0);
  const typed = battle as Battle & { battleMode?: string; source?: string; state?: string };
  const voteTokens = (battle.participants || []).slice(0, 2).map((participant) =>
    String(participant?.tokenAddress || participant?.tokenId || participant?.campaignAddress || "").trim(),
  );
  const showVote =
    typed.battleMode === "vote" &&
    typed.source !== "tournament" &&
    chainId > 0 &&
    typed.state === "live" &&
    voteTokens.length === 2 &&
    voteTokens.every(Boolean);
  return { showVote, voteTokens, chainId };
}

/** Card score fields from live regulation points (same shape presentVoteTournamentFight returns). */
export function liveVoteScore(leftPoints: number, rightPoints: number) {
  const left = Number.isFinite(leftPoints) ? leftPoints : 0;
  const right = Number.isFinite(rightPoints) ? rightPoints : 0;
  const gap = Math.abs(left - right);
  return {
    scoreKind: "vote",
    scoreCaption: "Votes",
    leftPointsLabel: String(left),
    rightPointsLabel: String(right),
    leaderIndex: left > right ? 0 : right > left ? 1 : null,
    gapLabel: gap > 0 ? `Gap ${gap}` : null,
    statusLabel: null,
  };
}

export function BattleWallCombatControls({ battle, voteState, metrics, realtimeState, dataSource }: Props) {
  const more = presentBattleWallMore(battle, metrics, { realtimeState, dataSource });
  const boostAvailable = battleBoostAvailability(battle).available;
  const { showVote, voteTokens, chainId } = battleVoteEligibility(battle);
  if (!showVote && !boostAvailable) return null;
  return (
    <CombatControls
      vote={voteState}
      battleId={more.battleId}
      chainId={chainId}
      showVote={showVote}
      showBoost={boostAvailable}
      voteTokens={voteTokens}
      left={more.left}
      right={more.right}
    />
  );
}

function CombatControls({
  vote,
  battleId,
  chainId,
  showVote,
  showBoost,
  voteTokens,
  left,
  right,
}: {
  vote: VoteState;
  battleId: string;
  chainId: number;
  showVote: boolean;
  showBoost: boolean;
  voteTokens: string[];
  left: { tokenId?: string | null; ticker?: string | null; name?: string | null };
  right: { tokenId?: string | null; ticker?: string | null; name?: string | null };
}) {
  const boost = useBattleBoost({ battleId, chainId, left, right });

  const sides: Array<{ key: SideKey; voteToken: string; boostToken?: string | null; points: number; votes: number }> = [
    { key: "left", voteToken: voteTokens[0], boostToken: left.tokenId, points: vote.model.leftPoints, votes: vote.model.leftVotes },
    { key: "right", voteToken: voteTokens[1], boostToken: right.tokenId, points: vote.model.rightPoints, votes: vote.model.rightVotes },
  ];
  const voteDisabled = !vote.payload || !vote.model.votingLive || Boolean(vote.model.walletVote) || Boolean(vote.busyToken);

  let note: string | null = null;
  if (showVote) {
    if (vote.unavailable) note = "Vote Battle runtime unavailable.";
    else if (!vote.payload) note = null;
    else if (!vote.model.votingLive) note = "Voting is closed for this battle.";
    else if (!vote.walletAddress) note = "Connect a wallet on this battle's chain to vote. One Free Vote per wallet; each Boost ($1) adds 2 pts.";
    else if (vote.model.walletVote) note = "Your Free Vote is in. Boosts ($1 each) still add 2 pts.";
    else note = "One Free Vote per wallet (1 pt). Each Boost costs $1 and adds 2 pts.";
  }

  return (
    <div data-battle-combat-controls="true" className="relative z-20 mt-3 space-y-2">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-10 lg:gap-24">
        {sides.map((side) => {
          const votedHere = Boolean(vote.model.walletVote) && vote.model.walletVote === side.voteToken;
          const payment = boost.isSolana ? boostPaymentLabel(boost.paymentStates[side.key]) : null;
          return (
            <div key={side.key} className="space-y-2" data-battle-combat-side={side.key}>
              {showVote ? (
                <button type="button" className={VOTE_CLASS} disabled={voteDisabled} onClick={() => void vote.vote(side.voteToken)}>
                  <ThumbsUp className="h-4 w-4" aria-hidden />
                  {vote.busyToken === side.voteToken ? "Confirming…" : votedHere ? "Voted" : "Vote"}
                </button>
              ) : null}
              {showBoost ? (
                <button
                  type="button"
                  className={BOOST_CLASS}
                  disabled={boost.disabled || !side.boostToken || boost.sideBlocked(side.key)}
                  onClick={() => void boost.boost(side.key, side.boostToken)}
                >
                  <Zap className="h-4 w-4" aria-hidden />
                  {boost.busySide === side.key ? "Boosting…" : "Boost"}
                </button>
              ) : null}
              <div className="text-center text-[10px] uppercase tracking-[0.16em] text-white/50">
                {showVote ? `${side.points} pts · ${side.votes} vote${side.votes === 1 ? "" : "s"}` : null}
                {showVote && showBoost ? " · " : null}
                {showBoost ? `${boost.totals[side.key]} boost${boost.totals[side.key] === 1 ? "" : "s"}` : null}
              </div>
              {payment ? <div className="text-center text-[10px] uppercase tracking-[0.12em] text-white/42">{payment}</div> : null}
            </div>
          );
        })}
      </div>
      {note ? <p className="text-center text-xs text-white/48">{note}</p> : null}
    </div>
  );
}
