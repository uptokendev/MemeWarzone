export const VOTE_TOURNAMENT_FREE_VOTE_POINTS = 1;
export const VOTE_TOURNAMENT_BOOST_POINTS_PER_UNIT = 2;
export const VOTE_TOURNAMENT_REGULATION_HOURS = 24;

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function presentTournamentVoteSummary(payload = {}) {
  const summary = payload?.summary || {};
  const leftVotes = Math.max(0, finite(summary.leftVotes) ?? 0);
  const rightVotes = Math.max(0, finite(summary.rightVotes) ?? 0);
  const totalVotes = Math.max(0, finite(summary.totalVotes) ?? leftVotes + rightVotes);
  const walletVote = String(payload?.walletVote || "").trim() || null;
  return {
    votingLive: payload?.votingLive === true,
    roundNumber: finite(payload?.roundNumber),
    matchId: String(payload?.matchId || "").trim() || null,
    battleId: String(payload?.battleId || "").trim() || null,
    tokenA: String(summary.tokenA || "").trim() || null,
    tokenB: String(summary.tokenB || "").trim() || null,
    leftVotes,
    rightVotes,
    totalVotes,
    leftPoints: leftVotes * VOTE_TOURNAMENT_FREE_VOTE_POINTS,
    rightPoints: rightVotes * VOTE_TOURNAMENT_FREE_VOTE_POINTS,
    walletVote,
    walletEligible: Boolean(payload?.votingLive === true && !walletVote),
    regulationLabel: `${VOTE_TOURNAMENT_REGULATION_HOURS}H REGULATION`,
    scoringLabel: "FREE VOTE = 1 PT · BOOST = 2 PTS",
    scoreScopeLabel: "FREE VOTE SCORE",
  };
}

export function tournamentVoteMatchRef(match = {}) {
  return String(match?.id || match?.battleId || match?.battle_id || "").trim();
}

export function shouldShowTournamentVoteControls({ mode, match } = {}) {
  const modeKey = String(mode?.key || mode || "").trim().toLowerCase();
  if (modeKey !== "vote") return false;
  if (!match || match?.bye === true || match?.winner) return false;
  return Boolean(tournamentVoteMatchRef(match) && match?.tokenA && match?.tokenB);
}
