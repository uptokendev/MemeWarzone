export const FINAL_SALVO_MAX_SHOTS = 5;
export const FINAL_SALVO_SHOT_SECONDS = 60;
export const FINAL_SALVO_WIN_TARGET = 3;

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function phaseKey(source = {}) {
  const raw = String(source?.phase || "").trim().toLowerCase();
  if (raw === "salvo" || raw === "final_salvo") return "final_salvo";
  if (raw === "sudden_death") return "sudden_death";
  return raw;
}

function secondsFromAuthoritativeDeadline(source = {}) {
  if (source?.secondsRemaining !== undefined && source?.secondsRemaining !== null) {
    return Math.min(FINAL_SALVO_SHOT_SECONDS, Math.max(0, integer(source.secondsRemaining, FINAL_SALVO_SHOT_SECONDS)));
  }
  const endsAt = String(source?.shotEndsAt || source?.shot_ends_at || "").trim();
  if (!endsAt) return FINAL_SALVO_SHOT_SECONDS;
  const endsMs = new Date(endsAt).getTime();
  if (!Number.isFinite(endsMs)) return FINAL_SALVO_SHOT_SECONDS;
  return Math.min(FINAL_SALVO_SHOT_SECONDS, Math.max(0, Math.ceil((endsMs - Date.now()) / 1000)));
}

export function presentFinalSalvoState(source = {}) {
  const phase = phaseKey(source);
  if (phase !== "final_salvo" && phase !== "sudden_death") return null;
  const suddenDeath = phase === "sudden_death" || source?.suddenDeath === true;
  const shotIndex = Math.max(1, integer(source?.shotIndex ?? source?.salvoIndex, 1));
  const leftSeries = integer(source?.series?.leftWins ?? source?.leftSeriesWins ?? source?.leftWins, 0);
  const rightSeries = integer(source?.series?.rightWins ?? source?.rightSeriesWins ?? source?.rightWins, 0);
  const secondsRemaining = secondsFromAuthoritativeDeadline(source);
  const leftVotes = integer(source?.currentShot?.leftUniqueVotes ?? source?.leftVotes, 0);
  const rightVotes = integer(source?.currentShot?.rightUniqueVotes ?? source?.rightVotes, 0);
  const walletVote = String(source?.currentShot?.walletVote ?? source?.walletVote ?? "").trim() || null;
  const shotClosed = source?.shotClosed === true || secondsRemaining === 0 || source?.active === false;
  const backendEligible = source?.currentShot?.walletEligible;
  const votingLive = source?.votingLive === true || (source?.active === true && !shotClosed);
  const walletEligible = backendEligible === undefined ? votingLive && !walletVote : Boolean(backendEligible) && votingLive && !shotClosed;
  const winner = String(source?.winner || source?.shotWinner || source?.winnerSide || "").trim() || null;
  return {
    phase,
    suddenDeath,
    title: suddenDeath ? "SUDDEN DEATH" : "FINAL SALVO",
    shotLabel: suddenDeath ? `SUDDEN DEATH · SHOT ${shotIndex}` : `SHOT ${Math.min(shotIndex, FINAL_SALVO_MAX_SHOTS)} / ${FINAL_SALVO_MAX_SHOTS}`,
    clockLabel: `${secondsRemaining}s`,
    secondsRemaining,
    leftVotes,
    rightVotes,
    leftSeries,
    rightSeries,
    seriesLabel: `${leftSeries} — ${rightSeries}`,
    walletVote,
    walletEligible,
    votingLive,
    shotClosed,
    winner,
    winTarget: FINAL_SALVO_WIN_TARGET,
    freeVoteOnly: true,
    boostAllowed: false,
  };
}

export function finalSalvoNeedsAnotherShot(model) {
  if (!model) return false;
  if (model.leftSeries >= FINAL_SALVO_WIN_TARGET || model.rightSeries >= FINAL_SALVO_WIN_TARGET) return false;
  if (model.suddenDeath) return model.leftVotes === model.rightVotes;
  return model.shotClosed && model.leftSeries < FINAL_SALVO_WIN_TARGET && model.rightSeries < FINAL_SALVO_WIN_TARGET;
}
