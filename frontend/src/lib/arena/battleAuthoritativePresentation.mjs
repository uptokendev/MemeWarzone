function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableString(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function normalizeComponent(value) {
  if (!value || typeof value !== "object") return null;
  return {
    points: finite(value.points),
    maxPoints: finite(value.maxPoints),
    start: finite(value.start),
    current: finite(value.current),
    changePct: finite(value.changePct),
  };
}

function normalizeVolume(value) {
  if (!value || typeof value !== "object") return null;
  return {
    points: finite(value.points),
    maxPoints: finite(value.maxPoints),
    rawUsd: finite(value.rawUsd),
    excludedUsd: finite(value.excludedUsd),
    eligibleUsd: finite(value.eligibleUsd),
  };
}

function normalizeBoost(value) {
  if (!value || typeof value !== "object") return null;
  return {
    points: finite(value.points),
    maxPoints: finite(value.maxPoints),
    confirmedUnits: finite(value.confirmedUnits),
    curveVersion: nullableString(value.curveVersion),
  };
}

function normalizeSide(value) {
  if (!value || typeof value !== "object") return null;
  return {
    side: nullableString(value.side),
    tokenId: nullableString(value.tokenId),
    totalPoints: finite(value.totalPoints),
    mcap: normalizeComponent(value.mcap),
    holders: normalizeComponent(value.holders),
    volume: normalizeVolume(value.volume),
    boost: normalizeBoost(value.boost),
  };
}

export function normalizeAuthoritativeBattleResult(value) {
  if (!value || typeof value !== "object") return null;
  const scoringGeneration = finite(value.scoringGeneration);
  const scoringVersion = nullableString(value.scoringVersion);
  const left = normalizeSide(value.sides?.left);
  const right = normalizeSide(value.sides?.right);
  const reasons = Array.isArray(value.dataHealth?.reasons)
    ? value.dataHealth.reasons.map((reason) => String(reason)).filter(Boolean)
    : [];
  const healthy = value.dataHealth?.healthy === true;
  return {
    scoringVersion,
    scoringGeneration,
    sides: { left, right },
    dataHealth: {
      healthy,
      status: nullableString(value.dataHealth?.status) || (healthy ? "healthy" : "unhealthy"),
      reasons,
    },
    battleResult: {
      state: nullableString(value.battleResult?.state),
      result: nullableString(value.battleResult?.result),
      draw: value.battleResult?.draw === true,
      winnerToken: nullableString(value.battleResult?.winnerToken),
    },
    moneyResult: {
      winnerToken: nullableString(value.moneyResult?.winnerToken),
      tieBreak: nullableString(value.moneyResult?.tieBreak),
      tieBreakUsed: value.moneyResult?.tieBreakUsed === true,
    },
  };
}

export function authoritativeLeaderSide(result) {
  if (!result?.dataHealth?.healthy) return null;
  const left = finite(result?.sides?.left?.totalPoints);
  const right = finite(result?.sides?.right?.totalPoints);
  if (left === null || right === null) return null;
  if (left === right) return "tied";
  return left > right ? "left" : "right";
}

export function authoritativeWinnerSide(result) {
  if (!result?.battleResult || result.battleResult.draw === true) return null;
  const winner = nullableString(result.battleResult.winnerToken);
  if (!winner) return null;
  if (winner === nullableString(result?.sides?.left?.tokenId)) return "left";
  if (winner === nullableString(result?.sides?.right?.tokenId)) return "right";
  return null;
}

export function authoritativeDraw(result) {
  return result?.battleResult?.draw === true;
}

export function authoritativeScoreRows(side, scoringGeneration) {
  if (!side) return [];
  const rows = [
    { key: "mcap", label: "MCAP", points: finite(side.mcap?.points), maxPoints: finite(side.mcap?.maxPoints) },
    { key: "holders", label: "Holders", points: finite(side.holders?.points), maxPoints: finite(side.holders?.maxPoints) },
    { key: "volume", label: "Eligible Volume", points: finite(side.volume?.points), maxPoints: finite(side.volume?.maxPoints) },
  ];
  if (Number(scoringGeneration) === 3) {
    rows.push({ key: "boost", label: "Boost", points: finite(side.boost?.points), maxPoints: finite(side.boost?.maxPoints) });
  }
  return rows;
}

export function authoritativeScoreAvailable(result) {
  if (!result?.dataHealth?.healthy) return false;
  return finite(result?.sides?.left?.totalPoints) !== null && finite(result?.sides?.right?.totalPoints) !== null;
}

export function authoritativeStatusLabel(result) {
  if (!result) return "Updating score";
  if (!result.dataHealth?.healthy) return "Awaiting verified market data";
  if (!authoritativeScoreAvailable(result)) return "Scoring temporarily unavailable";
  return null;
}
