/**
 * Battle modes (founder rule, 2026-09-21).
 *
 *   normal  metrics battle: market cap / holders / volume / boost points,
 *           24 hours minimum (24 / 72 / 168).
 *   vote    Vote Battle: free votes (1 pt) and boosts (2 pts per unit), the
 *           same scoring the Vote Tournament rounds already run, but as a
 *           standalone battle of 1, 6, 12 or 24 hours. Ties go to Final Salvo.
 *
 * Tournament battles keep their own mode from the tournament row (trigger
 * enforce_arena_tournament_battle_mode); nothing here applies to them.
 */

export const BATTLE_MODE_NORMAL = "normal";
export const BATTLE_MODE_VOTE = "vote";
export const BATTLE_MODES = Object.freeze([BATTLE_MODE_NORMAL, BATTLE_MODE_VOTE]);

export const NORMAL_BATTLE_DURATION_HOURS = Object.freeze([24, 72, 168]);
export const VOTE_BATTLE_DURATION_HOURS = Object.freeze([1, 6, 12, 24]);

export const VOTE_BATTLE_SCORING_VERSION = "vote_tournament_v1";
export const VOTE_BATTLE_COMPETITION_GENERATION = "arena_competition_v2";
export const VOTE_BATTLE_FREE_VOTE_POINTS = 1;
export const VOTE_BATTLE_BOOST_POINTS_PER_UNIT = 2;
/** arena_contest_actions.round_number for a standalone battle (the check is >= 1). */
export const VOTE_BATTLE_ROUND_NUMBER = 1;
/** arena_battles.settlement_version written by the Vote Battle settlement. */
export const VOTE_BATTLE_SETTLEMENT_VERSION = 4;

export const SCORE_BASIS_MCAP = "mcap_pct_change";
export const SCORE_BASIS_VOTES = "free_votes";

export function parseBattleMode(value, fallback = BATTLE_MODE_NORMAL) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === BATTLE_MODE_VOTE) return BATTLE_MODE_VOTE;
  if (mode === BATTLE_MODE_NORMAL) return BATTLE_MODE_NORMAL;
  return fallback === BATTLE_MODE_VOTE ? BATTLE_MODE_VOTE : BATTLE_MODE_NORMAL;
}

export function isVoteMode(value) {
  return parseBattleMode(value) === BATTLE_MODE_VOTE;
}

export function battleDurationOptions(mode) {
  return isVoteMode(mode) ? VOTE_BATTLE_DURATION_HOURS : NORMAL_BATTLE_DURATION_HOURS;
}

function normalFallback(fallback) {
  const n = Number(fallback);
  return NORMAL_BATTLE_DURATION_HOURS.includes(n) ? n : 24;
}

function voteFallback(fallback) {
  const n = Number(fallback);
  return VOTE_BATTLE_DURATION_HOURS.includes(n) ? n : 24;
}

/**
 * Mode-aware duration parse. Normal mode keeps the historical day shorthand
 * (1 / 3 / 7 days -> 24 / 72 / 168 hours). Vote mode takes exact hours only,
 * so "1" is one hour, never a day.
 */
export function parseBattleDurationHoursForMode(mode, value, fallback = 24) {
  const n = Number(value);
  if (isVoteMode(mode)) {
    if (VOTE_BATTLE_DURATION_HOURS.includes(n)) return n;
    return voteFallback(fallback);
  }
  if (NORMAL_BATTLE_DURATION_HOURS.includes(n)) return n;
  if (n === 1) return 24;
  if (n === 3) return 72;
  if (n === 7) return 168;
  return normalFallback(fallback);
}

export function battleScoreBasis(mode) {
  return isVoteMode(mode) ? SCORE_BASIS_VOTES : SCORE_BASIS_MCAP;
}

/** Scoring columns a Vote Battle row must carry (the normal-mode trigger does not fill them). */
export function voteBattleScoringColumns() {
  return {
    battle_mode: BATTLE_MODE_VOTE,
    contest_scoring_version: VOTE_BATTLE_SCORING_VERSION,
    competition_generation: VOTE_BATTLE_COMPETITION_GENERATION,
  };
}

/** A Vote Battle opened from the queue or a challenge, not a tournament round. */
export function isStandaloneVoteBattle(row) {
  if (!row) return false;
  const source = String(row.source ?? "queue").trim().toLowerCase();
  return isVoteMode(row.battle_mode ?? row.battleMode) && source !== "tournament";
}

/** Regulation is open while the battle is live and its clock has not run out. */
export function voteBattleRegulationOpen(row, nowMs = Date.now()) {
  if (!row || String(row.state || "") !== "live") return false;
  const endMs = row.ends_at ? Date.parse(row.ends_at) : Number.NaN;
  return Number.isFinite(endMs) && Number(nowMs) < endMs;
}

export function voteBattleSide(row, token) {
  const left = String(row?.challenger_token ?? "").trim();
  const right = String(row?.defender_token ?? "").trim();
  const target = String(token ?? "").trim();
  if (!target || !left || !right) return null;
  const evm = (value) => /^0x[0-9a-fA-F]{40}$/.test(value);
  const same = (a, b) => (evm(a) && evm(b) ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(target, left)) return "left";
  if (same(target, right)) return "right";
  return null;
}
