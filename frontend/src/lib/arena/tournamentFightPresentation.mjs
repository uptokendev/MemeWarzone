export const TOURNAMENT_ROUND_HOURS = 24;

export function presentTournamentFightMode(source = {}) {
  const raw = String(source?.battleMode || source?.battle_mode || source?.mode || "").trim().toLowerCase();
  if (raw === "vote") {
    return { key: "vote", label: "VOTE", durationHours: TOURNAMENT_ROUND_HOURS, bandLabel: "VOTE · 24H" };
  }
  if (raw === "normal") {
    return { key: "normal", label: "NORMAL", durationHours: TOURNAMENT_ROUND_HOURS, bandLabel: "NORMAL · 24H" };
  }
  return null;
}

export function presentTournamentFightActions({
  mode = null,
  mocksEnabled = false,
  boostRuntime = false,
  voteRuntime = false,
} = {}) {
  const key = String(mode || "").toLowerCase();
  const tournament = key === "normal" || key === "vote";
  if (!tournament) {
    return { showBoost: false, showVote: false, mockOnly: false };
  }
  const boostAllowed = boostRuntime === true || mocksEnabled === true;
  const voteAllowed = voteRuntime === true || mocksEnabled === true;
  return {
    showBoost: boostAllowed,
    showVote: key === "vote" && voteAllowed,
    mockOnly: mocksEnabled === true && boostRuntime !== true && voteRuntime !== true,
  };
}

function finiteScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

export function presentVoteTournamentFight(battle) {
  const left = finiteScore(battle?.participants?.[0]?.voteScore ?? battle?.participants?.[0]?.votes);
  const right = finiteScore(battle?.participants?.[1]?.voteScore ?? battle?.participants?.[1]?.votes);
  let leaderIndex = null;
  if (left != null && right != null) {
    if (left > right) leaderIndex = 0;
    else if (right > left) leaderIndex = 1;
  }
  const gap = left != null && right != null ? Math.abs(left - right) : null;
  return {
    scoreKind: "vote",
    scoreCaption: "Votes",
    leftPointsLabel: left == null ? null : String(left),
    rightPointsLabel: right == null ? null : String(right),
    leaderIndex,
    gapLabel: gap != null && gap > 0 ? `Gap ${gap}` : null,
    statusLabel: null,
  };
}

export function presentCurrentRoundMatches(rounds) {
  const list = (Array.isArray(rounds) ? rounds : [])
    .map((round) => ({
      round: Number(round?.round) || 0,
      matches: Array.isArray(round?.matches) ? round.matches : [],
    }))
    .filter((round) => round.round > 0 && round.matches.length)
    .sort((left, right) => left.round - right.round);
  if (!list.length) return [];
  const current =
    list.find((round) => round.matches.some((match) => !match?.winner && match?.bye !== true)) || list[list.length - 1];
  return current.matches.map((match) => ({ ...match, round: current.round }));
}
