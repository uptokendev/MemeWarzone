/**
 * Standalone Vote Battle voting: the Vote Tournament round rules
 * (one free vote per wallet, boosts = 2 pts) applied to a battle opened from
 * the queue or a challenge. Rows live in arena_contest_actions exactly like
 * tournament rounds, with tournament_id null, match_id = battle id and
 * round_number 1, so the existing Final Salvo and boost readers keep working.
 *
 * Every function takes a query function so it can run on the pool or inside a
 * transaction client, and so it can be tested without a database.
 */
import {
  VOTE_BATTLE_BOOST_POINTS_PER_UNIT,
  VOTE_BATTLE_COMPETITION_GENERATION,
  VOTE_BATTLE_FREE_VOTE_POINTS,
  VOTE_BATTLE_ROUND_NUMBER,
  isStandaloneVoteBattle,
  voteBattleRegulationOpen,
  voteBattleSide,
} from "./arenaBattleMode.js";
import { tournamentVoteSummary } from "./arenaTournamentVoteRuntime.mjs";

export const VOTE_BATTLE_COLUMNS = `id, chain_id, state, source, battle_mode, tournament_id, challenger_token, defender_token,
  participants, started_at, ends_at, duration_hours, contest_scoring_version, competition_generation`;

export async function loadVoteBattle(query, battleId, { forUpdate = false } = {}) {
  const result = await query(
    `select ${VOTE_BATTLE_COLUMNS}
       from public.arena_battles
      where id = $1
      limit 1${forUpdate ? " for update" : ""}`,
    [String(battleId)],
  );
  return result?.rows?.[0] || null;
}

export async function loadVoteBattleTiebreak(query, battleId) {
  const result = await query(
    `select battle_id, state from public.arena_vote_tiebreaks where battle_id = $1 limit 1`,
    [String(battleId)],
  );
  return result?.rows?.[0] || null;
}

/** The matchup shape the tournament vote code uses, derived from the battle row. */
export function voteBattleMatch(battle) {
  const battleId = String(battle?.id || "");
  return {
    battleId,
    matchId: battleId,
    roundNumber: VOTE_BATTLE_ROUND_NUMBER,
    tokenA: String(battle?.challenger_token || "").trim(),
    tokenB: String(battle?.defender_token || "").trim(),
  };
}

/**
 * Whether free votes are open on this battle right now. Boosts use the same
 * rule. `tiebreak` is the arena_vote_tiebreaks row when one exists (Final
 * Salvo running or resolved): free votes then go through the Final Salvo
 * route, never through regulation.
 */
export function voteBattleAvailability(battle, { nowMs = Date.now(), tiebreak = null } = {}) {
  if (!battle) return { ok: false, status: 404, code: "BATTLE_NOT_FOUND", error: "Battle not found" };
  if (!isStandaloneVoteBattle(battle)) {
    return { ok: false, status: 409, code: "BATTLE_NOT_VOTE_MODE", error: "This battle is not a Vote Battle." };
  }
  if (String(battle.competition_generation || "") !== VOTE_BATTLE_COMPETITION_GENERATION) {
    return { ok: false, status: 409, code: "BATTLE_NOT_V2", error: "Battle is not on Arena competition V2 rails." };
  }
  const match = voteBattleMatch(battle);
  if (!match.tokenA || !match.tokenB) {
    return { ok: false, status: 409, code: "VOTE_BATTLE_NOT_LIVE", error: "Vote Battle has no confirmed opponent yet." };
  }
  if (tiebreak) {
    return { ok: false, status: 409, code: "FINAL_SALVO_ACTIVE", error: "Regulation ended; this Vote Battle is in Final Salvo." };
  }
  if (String(battle.state || "") !== "live") {
    return { ok: false, status: 409, code: "VOTE_BATTLE_NOT_LIVE", error: "Vote Battle is not live." };
  }
  if (!voteBattleRegulationOpen(battle, nowMs)) {
    return { ok: false, status: 409, code: "VOTE_BATTLE_REGULATION_ENDED", error: "Vote Battle regulation has ended." };
  }
  return { ok: true, match };
}

export async function listVoteBattleVotes(query, battle) {
  const match = voteBattleMatch(battle);
  const result = await query(
    `select side, wallet, created_at
       from public.arena_contest_actions
      where battle_id = $1
        and tournament_id is null
        and round_number = $2
        and coalesce(match_id, battle_id) = $3
        and chain_id = $4
        and phase = 'regulation'
        and action_type = 'free_vote'
      order by created_at asc`,
    [match.battleId, match.roundNumber, match.matchId, Number(battle.chain_id)],
  );
  return result?.rows || [];
}

/** Confirmed regulation points per side (free votes + boosts). */
export async function voteBattleScore(query, battle) {
  const match = voteBattleMatch(battle);
  const result = await query(
    `select side, coalesce(sum(points), 0)::bigint as points
       from public.arena_contest_actions
      where battle_id = $1
        and round_number = $2
        and phase = 'regulation'
        and confirmed_at is not null
      group by side`,
    [match.battleId, match.roundNumber],
  );
  let leftPoints = 0;
  let rightPoints = 0;
  for (const row of result?.rows || []) {
    if (row.side === "left") leftPoints = Number(row.points || 0);
    if (row.side === "right") rightPoints = Number(row.points || 0);
  }
  return { leftPoints, rightPoints };
}

export function voteBattleSideFor(battle, token) {
  return voteBattleSide(battle, token);
}

/**
 * Records one free vote. Returns { inserted } with the new row, or
 * { inserted: null, existingSide } when the wallet already voted on this
 * battle (the partial unique index on regulation free votes rejects it).
 */
export async function recordVoteBattleFreeVote(query, battle, { wallet, side }) {
  const match = voteBattleMatch(battle);
  const inserted = await query(
    `insert into public.arena_contest_actions (
       chain_id, tournament_id, match_id, battle_id, round_number, phase, salvo_index,
       side, wallet, action_type, boost_units, points,
       gross_native_raw, pool_native_raw, protocol_native_raw, confirmed_at
     ) values ($1,null,$2,$3,$4,'regulation',null,$5,$6,'free_vote',0,$7,0,0,0,now())
     on conflict do nothing
     returning id, side, created_at`,
    [Number(battle.chain_id), match.matchId, match.battleId, match.roundNumber, side, wallet, VOTE_BATTLE_FREE_VOTE_POINTS],
  );
  if (inserted?.rows?.[0]) return { inserted: inserted.rows[0], existingSide: null };
  const existing = await query(
    `select side from public.arena_contest_actions
      where battle_id = $1
        and round_number = $2
        and coalesce(match_id, battle_id) = $3
        and wallet = $4
        and chain_id = $5
        and phase = 'regulation'
        and action_type = 'free_vote'
      limit 1`,
    [match.battleId, match.roundNumber, match.matchId, wallet, Number(battle.chain_id)],
  );
  return { inserted: null, existingSide: existing?.rows?.[0]?.side || null };
}

export function walletVoteToken(rows, wallet, match, normalize = (value) => String(value || "")) {
  const target = normalize(wallet);
  if (!target) return null;
  const found = (rows || []).find((row) => normalize(row.wallet || "") === target);
  if (!found) return null;
  return found.side === "left" ? match.tokenA : found.side === "right" ? match.tokenB : null;
}

export function voteBattlePayload({ battle, rows, score, walletVote = null, nowIso = new Date().toISOString() }) {
  const match = voteBattleMatch(battle);
  const summary = tournamentVoteSummary(rows, match);
  return {
    ok: true,
    chainId: Number(battle.chain_id),
    battleId: match.battleId,
    battleMode: "vote",
    roundNumber: match.roundNumber,
    matchId: match.matchId,
    phase: "regulation",
    votingLive: voteBattleRegulationOpen(battle),
    regulationEndsAt: battle.ends_at || null,
    durationHours: Number(battle.duration_hours || 0) || null,
    freeVotePoints: VOTE_BATTLE_FREE_VOTE_POINTS,
    boostPointsPerUsd: VOTE_BATTLE_BOOST_POINTS_PER_UNIT,
    summary,
    score: {
      leftPoints: Number(score?.leftPoints || 0),
      rightPoints: Number(score?.rightPoints || 0),
    },
    walletVote,
    updatedAt: nowIso,
  };
}
