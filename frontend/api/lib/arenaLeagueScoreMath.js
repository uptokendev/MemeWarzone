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

export function identToken(value) {
  return String(value || "").trim();
}

export function pairKey(left, right) {
  const a = identToken(left).toLowerCase();
  const b = identToken(right).toLowerCase();
  if (!a || !b) return "";
  return [a, b].sort().join(":");
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
