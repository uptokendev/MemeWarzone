const SHOT_SECONDS = 60;
const MAX_SALVO_SHOTS = 5;

function int(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw new Error("invalid-time");
  return date.toISOString();
}

function plusShot(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) throw new Error("invalid-time");
  return new Date(date.getTime() + SHOT_SECONDS * 1000).toISOString();
}

export function finalSalvoShotWinner(leftUnique, rightUnique) {
  const left = int(leftUnique);
  const right = int(rightUnique);
  if (left === right) return null;
  return left > right ? "left" : "right";
}

export function shouldResolveSalvoEarly({ shotIndex, leftWins, rightWins }) {
  const completed = Math.min(MAX_SALVO_SHOTS, int(shotIndex));
  const left = int(leftWins);
  const right = int(rightWins);
  const remaining = MAX_SALVO_SHOTS - completed;
  if (left > right + remaining) return "left";
  if (right > left + remaining) return "right";
  return null;
}

export function beginFinalSalvo({ regulationLeftPoints, regulationRightPoints, now = new Date() } = {}) {
  const left = int(regulationLeftPoints);
  const right = int(regulationRightPoints);
  if (left !== right) return { ok: false, reason: "regulation-not-tied" };
  const startedAt = iso(now);
  return {
    ok: true,
    state: "salvo",
    regulationLeftPoints: left,
    regulationRightPoints: right,
    currentSalvoIndex: 1,
    leftSalvoPoints: 0,
    rightSalvoPoints: 0,
    suddenDeathRound: 0,
    shotStartedAt: startedAt,
    shotEndsAt: plusShot(now),
    shotHistory: [],
    winnerSide: null,
    resolvedAt: null,
  };
}

export function closeFinalSalvoShot({ tiebreak, leftUnique, rightUnique, now = new Date() } = {}) {
  if (!tiebreak || !["salvo", "sudden_death"].includes(String(tiebreak.state || ""))) {
    return { ok: false, reason: "tiebreak-not-active" };
  }
  const phase = String(tiebreak.state);
  const leftVotes = int(leftUnique);
  const rightVotes = int(rightUnique);
  const shotWinner = finalSalvoShotWinner(leftVotes, rightVotes);
  const history = Array.isArray(tiebreak.shotHistory) ? [...tiebreak.shotHistory] : [];
  const endedAt = iso(now);
  const currentIndex = phase === "salvo" ? Math.max(1, int(tiebreak.currentSalvoIndex)) : Math.max(1, int(tiebreak.suddenDeathRound));
  history.push({
    phase,
    index: currentIndex,
    leftUniqueVotes: leftVotes,
    rightUniqueVotes: rightVotes,
    winnerSide: shotWinner,
    endedAt,
  });

  if (phase === "sudden_death") {
    if (shotWinner) {
      return {
        ok: true,
        state: "resolved",
        winnerSide: shotWinner,
        resolvedAt: endedAt,
        currentSalvoIndex: Math.max(0, int(tiebreak.currentSalvoIndex)),
        suddenDeathRound: currentIndex,
        leftSalvoPoints: int(tiebreak.leftSalvoPoints),
        rightSalvoPoints: int(tiebreak.rightSalvoPoints),
        shotStartedAt: null,
        shotEndsAt: null,
        shotHistory: history,
      };
    }
    return {
      ok: true,
      state: "sudden_death",
      winnerSide: null,
      resolvedAt: null,
      currentSalvoIndex: Math.max(0, int(tiebreak.currentSalvoIndex)),
      suddenDeathRound: currentIndex + 1,
      leftSalvoPoints: int(tiebreak.leftSalvoPoints),
      rightSalvoPoints: int(tiebreak.rightSalvoPoints),
      shotStartedAt: endedAt,
      shotEndsAt: plusShot(now),
      shotHistory: history,
    };
  }

  let leftWins = int(tiebreak.leftSalvoPoints);
  let rightWins = int(tiebreak.rightSalvoPoints);
  if (shotWinner === "left") leftWins += 1;
  else if (shotWinner === "right") rightWins += 1;

  const earlyWinner = shouldResolveSalvoEarly({ shotIndex: currentIndex, leftWins, rightWins });
  if (earlyWinner) {
    return {
      ok: true,
      state: "resolved",
      winnerSide: earlyWinner,
      resolvedAt: endedAt,
      currentSalvoIndex: currentIndex,
      suddenDeathRound: 0,
      leftSalvoPoints: leftWins,
      rightSalvoPoints: rightWins,
      shotStartedAt: null,
      shotEndsAt: null,
      shotHistory: history,
    };
  }

  if (currentIndex >= MAX_SALVO_SHOTS) {
    if (leftWins !== rightWins) {
      return {
        ok: true,
        state: "resolved",
        winnerSide: leftWins > rightWins ? "left" : "right",
        resolvedAt: endedAt,
        currentSalvoIndex: MAX_SALVO_SHOTS,
        suddenDeathRound: 0,
        leftSalvoPoints: leftWins,
        rightSalvoPoints: rightWins,
        shotStartedAt: null,
        shotEndsAt: null,
        shotHistory: history,
      };
    }
    return {
      ok: true,
      state: "sudden_death",
      winnerSide: null,
      resolvedAt: null,
      currentSalvoIndex: MAX_SALVO_SHOTS,
      suddenDeathRound: 1,
      leftSalvoPoints: leftWins,
      rightSalvoPoints: rightWins,
      shotStartedAt: endedAt,
      shotEndsAt: plusShot(now),
      shotHistory: history,
    };
  }

  return {
    ok: true,
    state: "salvo",
    winnerSide: null,
    resolvedAt: null,
    currentSalvoIndex: currentIndex + 1,
    suddenDeathRound: 0,
    leftSalvoPoints: leftWins,
    rightSalvoPoints: rightWins,
    shotStartedAt: endedAt,
    shotEndsAt: plusShot(now),
    shotHistory: history,
  };
}

export const FINAL_SALVO_SHOT_SECONDS = SHOT_SECONDS;
export const FINAL_SALVO_MAX_SHOTS = MAX_SALVO_SHOTS;
