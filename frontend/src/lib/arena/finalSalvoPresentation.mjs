export const FINAL_SALVO_MAX_SHOTS = 5;
export const FINAL_SALVO_SHOT_SECONDS = 60;
export const FINAL_SALVO_WIN_TARGET = 3;

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

export function presentFinalSalvoState(source = {}) {
  const phase = String(source?.phase || "").trim().toLowerCase();
  if (phase !== "final_salvo" && phase !== "sudden_death") return null;
  const suddenDeath = phase === "sudden_death" || source?.suddenDeath === true;
  const shotIndex = Math.max(1, integer(source?.shotIndex ?? source?.salvoIndex, 1));
  const leftSeries = integer(source?.leftSeriesWins ?? source?.leftWins, 0);
  const rightSeries = integer(source?.rightSeriesWins ?? source?.rightWins, 0);
  const secondsRemaining = Math.min(
    FINAL_SALVO_SHOT_SECONDS,
    Math.max(0, integer(source?.secondsRemaining, FINAL_SALVO_SHOT_SECONDS)),
  );
  const leftVotes = integer(source?.leftVotes, 0);
  const rightVotes = integer(source?.rightVotes, 0);
  const walletVote = String(source?.walletVote || "").trim() || null;
  const shotClosed = source?.shotClosed === true;
  const votingLive = source?.votingLive === true && !shotClosed;
  const winner = String(source?.winner || source?.shotWinner || "").trim() || null;
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
    walletEligible: votingLive && !walletVote,
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
