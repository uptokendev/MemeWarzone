import { BATTLE_POINTS_V2 } from "./arenaBattlePointsConfig.js";
import { canonicalTokenKey, MWL_RESULT } from "./arenaLeagueScoreMath.js";

export const BATTLE_POINTS_SETTLEMENT_VERSION = 2;
export const BATTLE_POINTS_TIE_EPSILON = 0.0001;
export const INVALID_BATTLE_POINTS_SNAPSHOT = "invalid_battle_points_snapshot";

export const BATTLE_POINTS_MONEY_TIE_BREAK = Object.freeze({
  BATTLE_POINTS: "battle_points",
  MCAP_COMPONENT: "mcap_component",
  HOLDER_COMPONENT: "holder_component",
  VOLUME_COMPONENT: "volume_component",
  TOKEN_ADDRESS: "token_address",
});

function finite(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compare(left, right, epsilon = BATTLE_POINTS_TIE_EPSILON) {
  const a = finite(left);
  const b = finite(right);
  if (a === null || b === null) return null;
  if (Math.abs(a - b) <= Math.max(0, Number(epsilon) || 0)) return 0;
  return a > b ? 1 : -1;
}

function normalizedSide(scored) {
  if (!scored || scored.dataHealth?.healthy !== true) return null;
  if (String(scored.scoringVersion || "") !== BATTLE_POINTS_V2) return null;

  const total = finite(scored.totalPoints);
  const mcapPoints = finite(scored.mcap?.points ?? scored.components?.mcapPoints);
  const holderPoints = finite(scored.holders?.points ?? scored.components?.holderPoints);
  const volumePoints = finite(scored.volume?.points ?? scored.components?.volumePoints);
  const startMcap = finite(scored.mcap?.start);
  const endMcap = finite(scored.mcap?.current);
  const mcapPct = finite(scored.performance?.mcapPct ?? scored.mcap?.changePct);

  if (
    total === null || total < 0 || total > 100 ||
    mcapPoints === null || mcapPoints < 0 ||
    holderPoints === null || holderPoints < 0 ||
    volumePoints === null || volumePoints < 0 ||
    startMcap === null || startMcap <= 0 ||
    endMcap === null || endMcap < 0 ||
    mcapPct === null
  ) {
    return null;
  }

  return {
    total,
    mcapPoints,
    holderPoints,
    volumePoints,
    startMcap,
    endMcap,
    mcapPct,
  };
}

function invalidDecision() {
  return {
    ok: false,
    reason: INVALID_BATTLE_POINTS_SNAPSHOT,
    settlementVersion: BATTLE_POINTS_SETTLEMENT_VERSION,
    settlementScoringVersion: BATTLE_POINTS_V2,
    mwlResult: null,
    mwlDraw: null,
    mwlWinnerSide: null,
    mwlWinnerToken: null,
    moneyWinnerSide: null,
    moneyWinnerToken: null,
    moneyTieBreak: null,
    tieBreakUsed: null,
  };
}

function rankedOutcome(left, right, epsilon) {
  const result = compare(left.total, right.total, epsilon);
  if (result === null) return null;
  if (result > 0) return { mwlResult: MWL_RESULT.LEFT_WIN, mwlDraw: false, mwlWinnerSide: "left" };
  if (result < 0) return { mwlResult: MWL_RESULT.RIGHT_WIN, mwlDraw: false, mwlWinnerSide: "right" };
  return { mwlResult: MWL_RESULT.DRAW, mwlDraw: true, mwlWinnerSide: null };
}

function deterministicMoneyWinner({ leftToken, rightToken, left, right, epsilon }) {
  const comparisons = [
    [left.total, right.total, BATTLE_POINTS_MONEY_TIE_BREAK.BATTLE_POINTS],
    [left.mcapPoints, right.mcapPoints, BATTLE_POINTS_MONEY_TIE_BREAK.MCAP_COMPONENT],
    [left.holderPoints, right.holderPoints, BATTLE_POINTS_MONEY_TIE_BREAK.HOLDER_COMPONENT],
    [left.volumePoints, right.volumePoints, BATTLE_POINTS_MONEY_TIE_BREAK.VOLUME_COMPONENT],
  ];

  for (const [leftValue, rightValue, tieBreak] of comparisons) {
    const result = compare(leftValue, rightValue, epsilon);
    if (result === null) return null;
    if (result !== 0) {
      return {
        moneyWinnerSide: result > 0 ? "left" : "right",
        moneyWinnerToken: result > 0 ? leftToken : rightToken,
        moneyTieBreak: tieBreak,
        tieBreakUsed: tieBreak !== BATTLE_POINTS_MONEY_TIE_BREAK.BATTLE_POINTS,
      };
    }
  }

  const leftKey = canonicalTokenKey(leftToken);
  const rightKey = canonicalTokenKey(rightToken);
  if (!leftKey || !rightKey) return null;
  const leftWins = leftKey >= rightKey;
  return {
    moneyWinnerSide: leftWins ? "left" : "right",
    moneyWinnerToken: leftWins ? leftToken : rightToken,
    moneyTieBreak: BATTLE_POINTS_MONEY_TIE_BREAK.TOKEN_ADDRESS,
    tieBreakUsed: true,
  };
}

/**
 * Battle Points V2 settlement decision. The inputs must come from the final
 * authoritative server-side Battle Points calculation for each combatant.
 * MWL may record a draw inside the score epsilon, while money settlement keeps
 * one deterministic recipient using component-level tie-breaks.
 */
export function decideBattlePointsSettlement({
  leftToken,
  rightToken,
  leftScored,
  rightScored,
  epsilon = BATTLE_POINTS_TIE_EPSILON,
} = {}) {
  const left = normalizedSide(leftScored);
  const right = normalizedSide(rightScored);
  if (!left || !right || !canonicalTokenKey(leftToken) || !canonicalTokenKey(rightToken)) {
    return invalidDecision();
  }

  const ranked = rankedOutcome(left, right, epsilon);
  const money = deterministicMoneyWinner({ leftToken, rightToken, left, right, epsilon });
  if (!ranked || !money) return invalidDecision();

  const mwlWinnerToken = ranked.mwlDraw
    ? null
    : ranked.mwlWinnerSide === "left"
      ? leftToken
      : rightToken;

  return {
    ok: true,
    reason: "ok",
    settlementVersion: BATTLE_POINTS_SETTLEMENT_VERSION,
    settlementScoringVersion: BATTLE_POINTS_V2,
    leftBattlePoints: left.total,
    rightBattlePoints: right.total,
    leftMcapPoints: left.mcapPoints,
    rightMcapPoints: right.mcapPoints,
    leftHolderPoints: left.holderPoints,
    rightHolderPoints: right.holderPoints,
    leftVolumePoints: left.volumePoints,
    rightVolumePoints: right.volumePoints,
    leftStartMcap: left.startMcap,
    rightStartMcap: right.startMcap,
    leftEndMcap: left.endMcap,
    rightEndMcap: right.endMcap,
    leftPct: left.mcapPct,
    rightPct: right.mcapPct,
    mwlResult: ranked.mwlResult,
    mwlDraw: ranked.mwlDraw,
    mwlWinnerSide: ranked.mwlWinnerSide,
    mwlWinnerToken,
    moneyWinnerSide: money.moneyWinnerSide,
    moneyWinnerToken: money.moneyWinnerToken,
    moneyTieBreak: money.moneyTieBreak,
    tieBreakUsed: money.tieBreakUsed,
  };
}
