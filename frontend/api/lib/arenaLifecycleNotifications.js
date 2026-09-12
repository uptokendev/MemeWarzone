/**
 * Arena notification producers. Called after durable battle/tournament writes.
 */

import { enqueueNotification, normalizeChain } from "./notificationContract.js";

async function safeEnqueue(db, input, label) {
  let usedSavepoint = false;
  try {
    try {
      await db.query("SAVEPOINT mwz_arena_notify");
      usedSavepoint = true;
    } catch {
      usedSavepoint = false;
    }
    const result = await enqueueNotification(db, input);
    if (usedSavepoint) await db.query("RELEASE SAVEPOINT mwz_arena_notify");
    return result;
  } catch (error) {
    if (usedSavepoint) {
      try { await db.query("ROLLBACK TO SAVEPOINT mwz_arena_notify"); } catch { /* keep product txn */ }
    }
    console.error(`[arena-lifecycle-notifications] ${label} failed`, error);
    return false;
  }
}

function competitor(chainId, token, extra = {}) {
  return {
    chainId,
    campaignId: token || null,
    ticker: extra.ticker || extra.symbol || null,
    name: extra.name || null,
  };
}

function battlePayload(row) {
  const chainId = Number(row.chain_id ?? row.chainId);
  const left = row.challenger_token || row.challengerToken;
  const right = row.defender_token || row.defenderToken;
  const winnerToken = row.winner_token || row.winnerToken;
  const winnerSide = winnerToken && String(winnerToken).toLowerCase() === String(right || "").toLowerCase()
    ? "right"
    : winnerToken
      ? "left"
      : undefined;
  return {
    battleId: String(row.id),
    generation: row.competition_generation || row.settlement_scoring_version || row.settlement_version || "v3",
    battleType: row.source === "tournament" || row.tournament_id || row.tournamentId ? "tournament" : "manual",
    scoringPolicyId: row.contest_scoring_version || row.settlement_scoring_version || null,
    left: competitor(chainId, left),
    right: competitor(chainId, right),
    startsAt: row.started_at || row.startedAt || null,
    endsAt: row.ends_at || row.endsAt || null,
    score: {
      left: row.challenger_battle_points ?? row.challengerBattlePoints ?? null,
      right: row.defender_battle_points ?? row.defenderBattlePoints ?? null,
    },
    winner: winnerToken ? { side: winnerSide, campaignId: winnerToken } : undefined,
  };
}

export async function notifyBattleCreated(db, row) {
  if (!db || !row?.id) return false;
  return safeEnqueue(db, {
    eventType: "battle.created",
    chainId: row.chain_id ?? row.chainId,
    entityType: "battle",
    entityId: String(row.id),
    dedupKey: `battle-created:${row.id}`,
    payload: battlePayload(row),
  }, "battle.created");
}

export async function notifyBattleStarted(db, row) {
  if (!db || !row?.id) return false;
  return safeEnqueue(db, {
    eventType: "battle.started",
    chainId: row.chain_id ?? row.chainId,
    entityType: "battle",
    entityId: String(row.id),
    dedupKey: `battle-started:${row.id}`,
    payload: battlePayload(row),
  }, "battle.started");
}

export async function notifyBattleFinalHours(db, row, window = "final-2h") {
  if (!db || !row?.id) return false;
  return safeEnqueue(db, {
    eventType: "battle.final_hours",
    chainId: row.chain_id ?? row.chainId,
    entityType: "battle",
    entityId: String(row.id),
    dedupKey: `battle-final-hours:${row.id}:${window}`,
    markerKey: `battle-final:${row.id}:${window}`,
    payload: { ...battlePayload(row), window },
  }, "battle.final_hours");
}

export async function notifyBattleWinnerConfirmed(db, row) {
  if (!db || !row?.id) return false;
  const version = String(row.settlement_version || row.settlementVersion || "1");
  return safeEnqueue(db, {
    eventType: "battle.winner_confirmed",
    chainId: row.chain_id ?? row.chainId,
    entityType: "battle",
    entityId: String(row.id),
    dedupKey: `battle-winner:${row.id}:${version}`,
    payload: battlePayload(row),
  }, "battle.winner_confirmed");
}

export async function notifyTournamentEvent(db, row, eventType) {
  if (!db || !row?.id) return false;
  const keys = {
    "tournament.registration_open": `tournament-registration-open:${row.id}`,
    "tournament.started": `tournament-started:${row.id}`,
    "tournament.round_completed": `tournament-round-complete:${row.id}:${row.round_id || row.roundId || "latest"}`,
    "tournament.winners_confirmed": `tournament-winners:${row.id}`,
  };
  const dedupKey = keys[eventType];
  if (!dedupKey) return false;
  return safeEnqueue(db, {
    eventType,
    chainId: row.chain_id ?? row.chainId,
    entityType: "tournament",
    entityId: String(row.id),
    dedupKey,
    payload: {
      tournamentId: String(row.id),
      tournamentType: row.tournament_type || row.tournamentType || "normal",
      name: row.name || null,
      roundId: row.round_id || row.roundId || null,
      startsAt: row.starts_at || row.startsAt || null,
      endsAt: row.ends_at || row.endsAt || null,
      winner: row.winner_token || row.winnerToken
        ? { campaignId: row.winner_token || row.winnerToken }
        : undefined,
    },
  }, eventType);
}

export function tournamentNotificationForTransition(prev, next) {
  const before = String(prev?.status || prev?.registration_state || "").toLowerCase();
  const after = String(next?.status || next?.registration_state || "").toLowerCase();
  const beforeReg = String(prev?.registration_state || "").toLowerCase();
  const afterReg = String(next?.registration_state || "").toLowerCase();
  if (afterReg.includes("open") && !beforeReg.includes("open")) return "tournament.registration_open";
  if ((after === "live" || after === "running") && before !== after) return "tournament.started";
  if ((after === "complete" || after === "completed" || after === "finished") && before !== after) {
    return "tournament.winners_confirmed";
  }
  return null;
}

export { normalizeChain };
