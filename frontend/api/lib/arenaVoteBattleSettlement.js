/**
 * Settlement of a standalone Vote Battle.
 *
 * The winner is the side with more confirmed regulation points (free votes +
 * boosts); an exact tie is decided by Final Salvo, exactly like a Vote
 * Tournament round. The battle row then carries the same money / MWL fields a
 * metrics battle carries (money_winner_token, mwl_result, mwl_winner_token,
 * settled_at), so the Solana operator and the EVM resolver read a Vote Battle
 * the way they read every other settled battle.
 */
import {
  VOTE_BATTLE_COMPETITION_GENERATION,
  VOTE_BATTLE_SCORING_VERSION,
  VOTE_BATTLE_SETTLEMENT_VERSION,
} from "./arenaBattleMode.js";
import { battleLeagueEligibility } from "./arenaBattleCompetition.js";
import { MWL_RESULT } from "./arenaLeagueScoreMath.js";

// The league ledger and the notification queue open the database pool when
// their modules load. They are pulled in at settlement time so the decision
// logic above stays importable without a DATABASE_URL (unit tests).
async function leagueRecorder(deps) {
  if (deps.recordFinishedBattle) return deps.recordFinishedBattle;
  return (await import("./arenaLeagueScore.js")).recordFinishedBattle;
}

async function winnerNotifier(deps) {
  if (deps.notifyBattleWinnerConfirmed) return deps.notifyBattleWinnerConfirmed;
  return (await import("./arenaLifecycleNotifications.js")).notifyBattleWinnerConfirmed;
}

function int(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function ident(value) {
  return String(value ?? "").trim();
}

/**
 * Pure decision. `winnerSide` is required when points are tied (Final Salvo
 * result); otherwise the higher side wins and a supplied side must agree.
 */
export function decideVoteBattleSettlement({ leftToken, rightToken, leftPoints, rightPoints, winnerSide = null, tieBreakUsed = false } = {}) {
  const left = ident(leftToken);
  const right = ident(rightToken);
  if (!left || !right || left === right) return { ok: false, reason: "invalid_tokens" };
  const lp = int(leftPoints);
  const rp = int(rightPoints);
  const byPoints = lp > rp ? "left" : rp > lp ? "right" : null;
  const side = winnerSide === "left" || winnerSide === "right" ? winnerSide : byPoints;
  if (!side) return { ok: false, reason: "tied" };
  if (byPoints && side !== byPoints) return { ok: false, reason: "winner_side_contradicts_points" };
  const winnerToken = side === "left" ? left : right;
  return {
    ok: true,
    reason: "ok",
    winnerSide: side,
    winnerToken,
    moneyWinnerSide: side,
    moneyWinnerToken: winnerToken,
    moneyTieBreak: null,
    mwlResult: side === "left" ? MWL_RESULT.LEFT_WIN : MWL_RESULT.RIGHT_WIN,
    mwlDraw: false,
    mwlWinnerSide: side,
    mwlWinnerToken: winnerToken,
    leftPoints: lp,
    rightPoints: rp,
    tieBreakUsed: Boolean(tieBreakUsed) || byPoints === null,
    settlementVersion: VOTE_BATTLE_SETTLEMENT_VERSION,
    settlementScoringVersion: VOTE_BATTLE_SCORING_VERSION,
  };
}

export function decorateVoteBattleParticipants(participants, decision) {
  const parts = Array.isArray(participants) ? participants.map((part) => ({ ...part })) : [];
  return parts.map((part, index) => ({
    ...part,
    votePoints: index === 0 ? decision.leftPoints : decision.rightPoints,
    isLeading: (index === 0 && decision.winnerSide === "left") || (index === 1 && decision.winnerSide === "right"),
  }));
}

export const VOTE_BATTLE_SETTLED_COLUMNS = `id, chain_id, state, source, battle_mode, challenger_token, defender_token, tournament_id,
  participants, winner_token, money_winner_token, money_tie_break, mwl_result, mwl_draw, mwl_winner_token,
  settlement_version, settlement_scoring_version, settlement_tie_break_used, settled_at, finished_at, updated_at`;

/**
 * Writes the settlement inside the caller's transaction. Returns the finished
 * row, or null when the battle was no longer live (lost race). League points
 * and the winner notification follow the metrics-battle path.
 */
export async function settleVoteBattle(client, battle, decision, nowIso, deps = {}) {
  if (!decision?.ok) throw new Error(`vote-battle-settlement-invalid:${decision?.reason || "unknown"}`);
  const participants = decorateVoteBattleParticipants(battle.participants, decision);
  const result = await client.query(
    `update public.arena_battles set
        state = 'finished', winner_token = $2, money_winner_token = $2, money_tie_break = null,
        mwl_result = $3, mwl_draw = false, mwl_winner_token = $2,
        settlement_version = $4, settlement_scoring_version = $5,
        contest_scoring_version = $5, competition_generation = $6,
        settlement_tie_break_used = $7, settled_at = $8::timestamptz, finished_at = $8::timestamptz,
        participants = $9::jsonb, updated_at = now()
      where id = $1 and state = 'live'
      returning ${VOTE_BATTLE_SETTLED_COLUMNS}`,
    [
      battle.id,
      decision.moneyWinnerToken,
      decision.mwlResult,
      decision.settlementVersion,
      decision.settlementScoringVersion,
      VOTE_BATTLE_COMPETITION_GENERATION,
      Boolean(decision.tieBreakUsed),
      nowIso,
      JSON.stringify(participants),
    ],
  );
  const finished = result.rows?.[0] || null;
  if (!finished) return null;

  const league = (deps.battleLeagueEligibility || battleLeagueEligibility)({ ...finished, participants });
  if (league.eligible || league.pointsMultiplier > 0) {
    const recordFinishedBattle = await leagueRecorder(deps);
    await recordFinishedBattle({ leaguePointsMultiplier: league.pointsMultiplier ?? 1,
      ...finished,
      mwlDraw: false,
      mwlWinnerToken: decision.mwlWinnerToken,
      mwlResult: decision.mwlResult,
      participants,
    }, client);
  }
  const notifyBattleWinnerConfirmed = await winnerNotifier(deps);
  await notifyBattleWinnerConfirmed(client, finished);
  return finished;
}
