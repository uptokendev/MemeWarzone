export const WIN_POINTS = 3;
export const LOSS_POINTS = 1;
export const DRAW_POINTS = 0;
export const TOURNAMENT_WIN_BONUS = 2;
export const CHECKIN_POINTS = 0.1;
export const STREAK_BONUS_POINTS = 0.5;
export const DISPATCH_POINTS = 0.25;
export const PAIR_WINDOW_DAYS = 7;
export const QF_MIN_FIGHTS = 3;
export const QF_SEED_SIZE = 8;
export const SETTLEMENT_VERSION = 1;
export const INVALID_MARKET_CAP_SNAPSHOT = "invalid_market_cap_snapshot";

/** left = challenger (A), right = defender (B). Never reuse "winner" for money vs MWL. */
export const MWL_RESULT = Object.freeze({
  LEFT_WIN: "left_win",
  RIGHT_WIN: "right_win",
  DRAW: "draw",
});
export const MONEY_TIE_BREAK = Object.freeze({
  PERFORMANCE: "performance",
  ENDING_MCAP: "ending_mcap",
  TOKEN_ADDRESS: "token_address",
});

/**
 * 4a freeze: a 7-day capped rematch still counts as a completed fight
 * (`countFight: true`) but writes no new MWL points (`skipPoints: true`).
 * Current 4a behavior, not final QF qualification policy.
 */
export const REMATCH_FIGHT_POLICY = "count_fight_skip_points";

export const MISSING_BATTLE_CHAIN_ID = "MISSING_BATTLE_CHAIN_ID";

export function identToken(value) {
  return String(value || "").trim();
}

export function canonicalTokenKey(value) {
  const raw = identToken(value);
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) return raw.toLowerCase();
  return raw;
}

export function pairKey(left, right) {
  const a = canonicalTokenKey(left);
  const b = canonicalTokenKey(right);
  if (!a || !b) return "";
  return [a, b].sort().join(":");
}

export function requireBattleChainId(row) {
  const chainId = Number(row?.chain_id ?? row?.chainId);
  if (!Number.isFinite(chainId) || chainId <= 0) {
    return { ok: false, reason: MISSING_BATTLE_CHAIN_ID, chainId: null };
  }
  return { ok: true, reason: "ok", chainId };
}

export function pairScoringLockKey(seasonId, key) {
  return `${String(seasonId || "").trim()}:${String(key || "").trim()}`;
}

function finiteMcap(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Parse a supplied mcap without turning missing/invalid into 0. */
export function parseAuthoritativeMcap(value) {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function assertAuthoritativeMarketCaps({
  leftStartMcap,
  rightStartMcap,
  leftEndMcap,
  rightEndMcap,
} = {}) {
  const leftStart = parseAuthoritativeMcap(leftStartMcap);
  const rightStart = parseAuthoritativeMcap(rightStartMcap);
  const leftEnd = parseAuthoritativeMcap(leftEndMcap);
  const rightEnd = parseAuthoritativeMcap(rightEndMcap);
  if (leftStart === null || leftStart <= 0 || rightStart === null || rightStart <= 0) {
    return { ok: false, reason: INVALID_MARKET_CAP_SNAPSHOT };
  }
  if (leftEnd === null || leftEnd < 0 || rightEnd === null || rightEnd < 0) {
    return { ok: false, reason: INVALID_MARKET_CAP_SNAPSHOT };
  }
  return { ok: true, leftStart, rightStart, leftEnd, rightEnd };
}

function invalidSettlement() {
  return {
    ok: false,
    reason: INVALID_MARKET_CAP_SNAPSHOT,
    settlementVersion: SETTLEMENT_VERSION,
    mwlResult: null,
    mwlDraw: null,
    mwlWinnerSide: null,
    mwlWinnerToken: null,
    moneyWinnerToken: null,
    moneyWinnerSide: null,
    moneyTieBreak: null,
    ledger: null,
  };
}

/** Ratio, not percent. Pure helper; canonical settlement must not use the zero-start fallback. */
export function pctChange(startMcap, endMcap) {
  const start = finiteMcap(startMcap);
  const end = finiteMcap(endMcap);
  if (start <= 0) return end > 0 ? 1 : 0;
  return (end - start) / start;
}

export function compareTokenIdentity(left, right) {
  const a = canonicalTokenKey(left);
  const b = canonicalTokenKey(right);
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

export function mwlOutcome({ leftPct, rightPct } = {}) {
  const left = Number(leftPct);
  const right = Number(rightPct);
  const leftN = Number.isFinite(left) ? left : 0;
  const rightN = Number.isFinite(right) ? right : 0;
  if (leftN > rightN) {
    return { mwlResult: MWL_RESULT.LEFT_WIN, mwlDraw: false, mwlWinnerSide: "left" };
  }
  if (rightN > leftN) {
    return { mwlResult: MWL_RESULT.RIGHT_WIN, mwlDraw: false, mwlWinnerSide: "right" };
  }
  return { mwlResult: MWL_RESULT.DRAW, mwlDraw: true, mwlWinnerSide: null };
}

export function moneyWinner({
  leftToken,
  rightToken,
  leftPct,
  rightPct,
  leftEndMcap,
  rightEndMcap,
} = {}) {
  const left = identToken(leftToken);
  const right = identToken(rightToken);
  if (!left || !right) throw new Error("moneyWinner requires both tokens");
  const leftN = Number.isFinite(Number(leftPct)) ? Number(leftPct) : 0;
  const rightN = Number.isFinite(Number(rightPct)) ? Number(rightPct) : 0;
  if (leftN > rightN) {
    return { moneyWinnerToken: leftToken, moneyWinnerSide: "left", moneyTieBreak: MONEY_TIE_BREAK.PERFORMANCE };
  }
  if (rightN > leftN) {
    return { moneyWinnerToken: rightToken, moneyWinnerSide: "right", moneyTieBreak: MONEY_TIE_BREAK.PERFORMANCE };
  }
  const leftEnd = finiteMcap(leftEndMcap);
  const rightEnd = finiteMcap(rightEndMcap);
  if (leftEnd > rightEnd) {
    return { moneyWinnerToken: leftToken, moneyWinnerSide: "left", moneyTieBreak: MONEY_TIE_BREAK.ENDING_MCAP };
  }
  if (rightEnd > leftEnd) {
    return { moneyWinnerToken: rightToken, moneyWinnerSide: "right", moneyTieBreak: MONEY_TIE_BREAK.ENDING_MCAP };
  }
  return compareTokenIdentity(left, right) >= 0
    ? { moneyWinnerToken: leftToken, moneyWinnerSide: "left", moneyTieBreak: MONEY_TIE_BREAK.TOKEN_ADDRESS }
    : { moneyWinnerToken: rightToken, moneyWinnerSide: "right", moneyTieBreak: MONEY_TIE_BREAK.TOKEN_ADDRESS };
}

export function pairPointsEligible({ pairAlreadyScored = false, frozen = false, isQuarterFinals = false } = {}) {
  if (frozen) return { eligible: false, reason: "frozen" };
  if (isQuarterFinals) return { eligible: false, reason: "quarter_finals" };
  if (pairAlreadyScored) return { eligible: false, reason: "pair_window" };
  return { eligible: true, reason: "ok" };
}

export function mwlLedgerPlan({
  mwlDraw,
  mwlWinnerToken,
  leftToken,
  rightToken,
  pairAlreadyScored = false,
  frozen = false,
  isQuarterFinals = false,
  isTournament = false,
} = {}) {
  return battlePointPlan({
    winner: mwlDraw ? null : mwlWinnerToken,
    left: leftToken,
    right: rightToken,
    pairAlreadyScored,
    frozen,
    isQuarterFinals,
    isTournament,
  });
}

/** Canonical 4a settlement decision. API code should call this instead of inventing outcome rules. */
export function settleBattleResult({
  leftToken,
  rightToken,
  leftStartMcap,
  rightStartMcap,
  leftEndMcap,
  rightEndMcap,
  pairAlreadyScored = false,
  frozen = false,
  isQuarterFinals = false,
  isTournament = false,
} = {}) {
  const snapshot = assertAuthoritativeMarketCaps({
    leftStartMcap,
    rightStartMcap,
    leftEndMcap,
    rightEndMcap,
  });
  if (!snapshot.ok) return invalidSettlement();
  const leftPct = pctChange(snapshot.leftStart, snapshot.leftEnd);
  const rightPct = pctChange(snapshot.rightStart, snapshot.rightEnd);
  const mwl = mwlOutcome({ leftPct, rightPct });
  const money = moneyWinner({
    leftToken,
    rightToken,
    leftPct,
    rightPct,
    leftEndMcap: snapshot.leftEnd,
    rightEndMcap: snapshot.rightEnd,
  });
  const mwlWinnerToken = mwl.mwlDraw ? null : mwl.mwlWinnerSide === "left" ? leftToken : rightToken;
  const ledger = mwlLedgerPlan({
    mwlDraw: mwl.mwlDraw,
    mwlWinnerToken,
    leftToken,
    rightToken,
    pairAlreadyScored,
    frozen,
    isQuarterFinals,
    isTournament,
  });
  return {
    ok: true,
    reason: "ok",
    settlementVersion: SETTLEMENT_VERSION,
    leftStartMcap: snapshot.leftStart,
    rightStartMcap: snapshot.rightStart,
    leftEndMcap: snapshot.leftEnd,
    rightEndMcap: snapshot.rightEnd,
    leftPct,
    rightPct,
    mwlResult: mwl.mwlResult,
    mwlDraw: mwl.mwlDraw,
    mwlWinnerSide: mwl.mwlWinnerSide,
    mwlWinnerToken,
    moneyWinnerToken: money.moneyWinnerToken,
    moneyWinnerSide: money.moneyWinnerSide,
    moneyTieBreak: money.moneyTieBreak,
    ledger,
  };
}

export function utcDay(date = new Date()) {
  return new Date(date).toISOString().slice(0, 10);
}

export function yesterdayUtc(day) {
  const stamp = new Date(`${String(day)}T00:00:00.000Z`);
  if (Number.isNaN(stamp.getTime())) return "";
  stamp.setUTCDate(stamp.getUTCDate() - 1);
  return stamp.toISOString().slice(0, 10);
}

export function nextCheckinStreak(lastDay, today, lastStreak) {
  const previous = Number(lastStreak || 0);
  if (!lastDay) return 1;
  if (lastDay === today) return Math.max(1, previous);
  if (lastDay === yesterdayUtc(today)) return previous + 1;
  return 1;
}

export function streakBonusDue(streak) {
  const days = Number(streak || 0);
  return days > 0 && days % 7 === 0;
}

export function seasonAcceptsRegularPoints(season) {
  if (!season) return true;
  if (season.regular_season_closed || season.frozen_at) return false;
  const state = String(season.state || "");
  return state !== "quarter_finals" && state !== "completed";
}

export function battlePointPlan({
  winner,
  left,
  right,
  pairAlreadyScored = false,
  frozen = false,
  isQuarterFinals = false,
  isTournament = false,
} = {}) {
  const empty = {
    skipPoints: true,
    countFight: !frozen && !isQuarterFinals,
    left: { points: 0, wins: 0, losses: 0, kind: null },
    right: { points: 0, wins: 0, losses: 0, kind: null },
  };
  if (frozen || isQuarterFinals) return { ...empty, countFight: false };
  if (pairAlreadyScored) return empty;

  const winPoints = WIN_POINTS + (isTournament ? TOURNAMENT_WIN_BONUS : 0);
  if (winner && winner === left) {
    return {
      skipPoints: false,
      countFight: true,
      left: { points: winPoints, wins: 1, losses: 0, kind: "battle_win" },
      right: { points: LOSS_POINTS, wins: 0, losses: 1, kind: "battle_loss" },
    };
  }
  if (winner && winner === right) {
    return {
      skipPoints: false,
      countFight: true,
      left: { points: LOSS_POINTS, wins: 0, losses: 1, kind: "battle_loss" },
      right: { points: winPoints, wins: 1, losses: 0, kind: "battle_win" },
    };
  }
  return {
    skipPoints: false,
    countFight: true,
    left: { points: DRAW_POINTS, wins: 0, losses: 0, kind: "battle_draw" },
    right: { points: DRAW_POINTS, wins: 0, losses: 0, kind: "battle_draw" },
  };
}

export function quarterFinalSeeds(entries) {
  return [...(entries || [])]
    .filter((entry) => Number(entry.finishedFights ?? entry.finished_fights ?? 0) >= QF_MIN_FIGHTS)
    .sort((left, right) => Number(right.points || 0) - Number(left.points || 0) || Number(right.wins || 0) - Number(left.wins || 0))
    .slice(0, QF_SEED_SIZE);
}
