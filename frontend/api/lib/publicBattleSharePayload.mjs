import { pool } from "../../server/db.js";
import { getArenaTokenProfile } from "./arenaTokenProfile.js";
import { readPublicBattleMetricsSnapshot } from "./arenaBattleRealtime.js";

function text(value) {
  const raw = String(value || "").trim();
  return raw || null;
}

function publicParticipant(entry = {}) {
  return {
    tokenId: text(entry.tokenAddress || entry.tokenId || entry.campaignAddress),
    tokenAddress: text(entry.tokenAddress || entry.tokenId || entry.campaignAddress),
    campaignAddress: text(entry.campaignAddress),
    tokenName: text(entry.tokenName || entry.name),
    symbol: text(entry.symbol),
    imageUrl: text(entry.imageUrl || entry.logoUrl || entry.logo_url),
    origin: text(entry.origin),
  };
}

async function enrichParticipant(chainId, participant) {
  const identity = participant.tokenAddress || participant.tokenId;
  if (!identity) return participant;
  try {
    const profile = await getArenaTokenProfile(chainId, identity);
    if (!profile) return participant;
    return {
      ...participant,
      tokenName: participant.tokenName || text(profile.name),
      symbol: participant.symbol || text(profile.symbol),
      imageUrl: participant.imageUrl || text(profile.imageUrl),
      origin: participant.origin || text(profile.origin),
    };
  } catch {
    return participant;
  }
}

export function toPublicShareBattle(row, participants) {
  if (!row?.id) return null;
  return {
    id: String(row.id),
    chainId: Number(row.chain_id || 0),
    state: String(row.state || ""),
    source: String(row.source || "queue"),
    tournamentId: row.tournament_id || null,
    settlementVersion: row.settlement_version || null,
    scoreBasis: row.score_basis || (Number(row.settlement_version) === 1 ? "mcap_pct_change" : null),
    winnerToken: row.money_winner_token || row.winner_token || null,
    startedAt: row.started_at || row.created_at || null,
    endsAt: row.ends_at || null,
    participants,
  };
}

export async function loadPublicBattleSharePayload(battleId) {
  const id = String(battleId || "").trim();
  if (!id || !pool) return null;
  const result = await pool.query(
    `select id, chain_id, state, source, tournament_id, settlement_version, settlement_scoring_version,
            winner_token, money_winner_token, started_at, ends_at, created_at, participants,
            challenger_token, defender_token
       from public.arena_battles
      where id = $1
      limit 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;

  const rawParticipants = Array.isArray(row.participants) ? row.participants.slice(0, 2) : [];
  while (rawParticipants.length < 2) rawParticipants.push({});
  if (!rawParticipants[0]?.tokenAddress && row.challenger_token) {
    rawParticipants[0] = { ...rawParticipants[0], tokenAddress: row.challenger_token };
  }
  if (!rawParticipants[1]?.tokenAddress && row.defender_token) {
    rawParticipants[1] = { ...rawParticipants[1], tokenAddress: row.defender_token };
  }

  const chainId = Number(row.chain_id || 0);
  const participants = await Promise.all(
    rawParticipants.map((entry) => enrichParticipant(chainId, publicParticipant(entry))),
  );
  const battle = toPublicShareBattle(row, participants);
  let metrics = null;
  try {
    metrics = await readPublicBattleMetricsSnapshot(row);
  } catch (error) {
    console.warn("[publicBattleSharePayload] metrics read failed", id, error?.message || error);
  }

  return { battle, metrics };
}
