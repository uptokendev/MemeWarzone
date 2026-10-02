import type { ReactNode } from "react";
import { Check, Zap } from "lucide-react";

import { boostPaymentLabel, useBattleBoost } from "@/components/arena/BattleBoostPanel";
import type { useBattleVote } from "@/components/arena/BattleVoteControls";
import type { Battle } from "@/features/postgrad/contracts";
import type { BattleRealtimeMetrics } from "@/lib/arena/battleRealtime";
import { battleBoostAvailability } from "@/lib/arena/battleBoostPresentation.mjs";
import { presentBattleWallMore } from "@/lib/arena/battleWallMorePresentation.mjs";

type VoteState = ReturnType<typeof useBattleVote>;

type SideKey = "left" | "right";

/** What the battle card places into each combatant's action strip, plus one shared hint line. */
export type BattleCombatSlots = { left: ReactNode; right: ReactNode; note: ReactNode };

type Props = {
  battle: Battle;
  /** Owned by the battle card so its VOTES box and these buttons read one live vote state. */
  voteState: VoteState;
  metrics?: BattleRealtimeMetrics | null;
  realtimeState?: string | null;
  dataSource?: string | null;
  children: (slots: BattleCombatSlots) => ReactNode;
};

const EMPTY_SLOTS: BattleCombatSlots = { left: null, right: null, note: null };

// Side by side under the metric boxes (UI redesign artboard: Vote warm outline, Boost solid orange).
const BUTTON_BASE =
  "mw-focus inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-[10px] border px-3 font-mw-body text-[15px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45";
const VOTE_CLASS = `${BUTTON_BASE} border-[#5A3416] bg-[#2A1A10] text-mw-accent-soft hover:bg-[#3A2412]`;
const VOTED_CLASS = "bg-[#3A2412] text-[#C79A72]";
const BOOST_CLASS = `${BUTTON_BASE} border-mw-accent bg-mw-accent text-[#140A02] hover:bg-[#FF8F3D]`;

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
  // The score is read for every Vote Battle with both sides set -- live AND finished (a finished
  // battle kept its votes on the server, but the card stopped asking and showed "—"). Casting a
  // vote or boost stays live-only.
  const showScore =
    typed.battleMode === "vote" &&
    typed.source !== "tournament" &&
    chainId > 0 &&
    voteTokens.length === 2 &&
    voteTokens.every(Boolean) &&
    !["challenged", "pending", "declined", "expired", "cancelled"].includes(String(typed.state || ""));
  const showVote = showScore && typed.state === "live";
  return { showVote, showScore, voteTokens, chainId };
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

export function BattleWallCombatControls({ battle, voteState, metrics, realtimeState, dataSource, children }: Props) {
  const more = presentBattleWallMore(battle, metrics, { realtimeState, dataSource });
  const boostAvailable = battleBoostAvailability(battle).available;
  const { showVote, voteTokens, chainId } = battleVoteEligibility(battle);
  // Only battles that can take a vote or a boost mount the boost hook (and its reads).
  if (!showVote && !boostAvailable) return <>{children(EMPTY_SLOTS)}</>;
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
    >
      {children}
    </CombatControls>
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
  children,
}: {
  vote: VoteState;
  battleId: string;
  chainId: number;
  showVote: boolean;
  showBoost: boolean;
  voteTokens: string[];
  left: { tokenId?: string | null; ticker?: string | null; name?: string | null };
  right: { tokenId?: string | null; ticker?: string | null; name?: string | null };
  children: (slots: BattleCombatSlots) => ReactNode;
}) {
  const boost = useBattleBoost({ battleId, chainId, left, right });

  const sides: Array<{ key: SideKey; voteToken: string; boostToken?: string | null }> = [
    { key: "left", voteToken: voteTokens[0], boostToken: left.tokenId },
    { key: "right", voteToken: voteTokens[1], boostToken: right.tokenId },
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

  const renderSide = (side: (typeof sides)[number]) => {
    const votedHere = Boolean(vote.model.walletVote) && vote.model.walletVote === side.voteToken;
    const payment = boost.isSolana ? boostPaymentLabel(boost.paymentStates[side.key]) : null;
    const boosts = boost.totals[side.key];
    return (
      <div data-battle-combat-buttons={side.key}>
        <div className="grid min-w-0 grid-cols-2 gap-2">
          {showVote ? (
            <button type="button" className={votedHere ? `${VOTE_CLASS} ${VOTED_CLASS}` : VOTE_CLASS} disabled={voteDisabled} onClick={() => void vote.vote(side.voteToken)}>
              <Check className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{vote.busyToken === side.voteToken ? "Confirming…" : votedHere ? "Voted" : "Vote"}</span>
            </button>
          ) : null}
          {showBoost ? (
            <button
              type="button"
              className={BOOST_CLASS}
              disabled={boost.disabled || !side.boostToken || boost.sideBlocked(side.key)}
              // A confirmed boost adds 2 pts server-side; re-read the tally now instead of waiting
              // for the 15 s vote poll.
              onClick={() => void boost.boost(side.key, side.boostToken).finally(() => void vote.refresh())}
              title={`${boosts} boost${boosts === 1 ? "" : "s"} on this side`}
            >
              <Zap className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{boost.busySide === side.key ? "Boosting…" : boosts > 0 ? `Boost · ${boosts}` : "Boost"}</span>
            </button>
          ) : null}
        </div>
        {payment ? <div className="mt-1 text-center text-xs text-mw-muted">{payment}</div> : null}
      </div>
    );
  };

  return (
    <>
      {children({
        left: renderSide(sides[0]),
        right: renderSide(sides[1]),
        note: note ? <p data-battle-combat-note="true" className="relative z-20 m-0 text-center font-mw-body text-sm text-[#C9CED4]">{note}</p> : null,
      })}
    </>
  );
}
