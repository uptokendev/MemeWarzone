import { pool } from "../../server/db.js";
import { advanceTournamentFromBattle } from "../arenaTournaments.js";
import { battleLeagueEligibility } from "./arenaBattleCompetition.js";
import { battlePointsV2PersistenceEnabled } from "./arenaBattlePointsConfig.js";
import { reconcileBattlePointsAtClose } from "./arenaBattleFinalScore.js";
import { battleSettlementPatch, decorateSettledParticipants } from "./arenaBattleSettle.js";
import { decideBattlePointsSettlement } from "./arenaBattleSettleV2.js";
import { recordFinishedBattle } from "./arenaLeagueScore.js";

const SETTLE_COLUMNS = `id, chain_id, state, source, challenger_token, defender_token, tournament_id,
  participants, started_at, ends_at, created_at, updated_at`;

function nowIso() { return new Date().toISOString(); }

export function battlePointsV2SettlementEnabled() { return battlePointsV2PersistenceEnabled(); }
export function shouldLegacyArenaSettle() { return !battlePointsV2SettlementEnabled(); }

export async function settleBattlePointsV2ById(battleId, deps = {}) {
  if (!deps.force && !battlePointsV2SettlementEnabled()) return { settled: false, reason: "battle_points_v2_disabled" };
  const db = deps.pool || pool;
  const client = await db.connect();
  let finished = null;
  let decision = null;
  let league = null;
  let finalScore = null;
  try {
    await client.query("begin");
    const locked = await client.query(
      `select ${SETTLE_COLUMNS}
         from public.arena_battles b
        where b.id = $1
          and b.state = 'live'
          and b.ends_at is not null
          and b.ends_at <= now()
          and not exists (
            select 1 from public.arena_battle_scoring_locks l
             where l.battle_id = b.id and l.scoring_version = 'battle_points_v3'
          )
        for update`,
      [String(battleId)],
    );
    const current = locked.rows[0];
    if (!current) {
      await client.query("commit");
      return { settled: false, reason: "not_due_already_settled_or_explicit_v3" };
    }

    const query = (text, params) => client.query(text, params);
    finalScore = await reconcileBattlePointsAtClose(current, {
      query,
      getSnapshot: deps.getSnapshot,
      nativeUsd: deps.nativeUsd,
      resolveNativeUsd: deps.resolveNativeUsd,
    });
    if (!finalScore.ok) {
      await client.query("rollback");
      return { settled: false, reason: finalScore.reason, dataDelay: true, side: finalScore.side || null };
    }

    decision = decideBattlePointsSettlement({
      leftToken: current.challenger_token,
      rightToken: current.defender_token,
      leftScored: finalScore.sides.left,
      rightScored: finalScore.sides.right,
    });
    if (!decision.ok) {
      await client.query("rollback");
      return { settled: false, reason: decision.reason, dataDelay: true };
    }

    const participants = decorateSettledParticipants(current.participants, decision);
    league = battleLeagueEligibility({ ...current, participants });
    if (league.eligible) {
      await recordFinishedBattle({ ...current, mwlDraw: decision.mwlDraw, mwlWinnerToken: decision.mwlWinnerToken, mwlResult: decision.mwlResult, participants }, client);
    }

    const settledAt = nowIso();
    const write = battleSettlementPatch(decision, { nowIso: settledAt, participants, metricsUpdatedAt: finalScore.metricsUpdatedAt });
    const result = await client.query(
      `update public.arena_battles set
          state = 'finished', winner_token = $2, money_winner_token = $3, money_tie_break = $4,
          mwl_result = $5, mwl_draw = $6, mwl_winner_token = $7,
          challenger_end_mcap_usd = $8, defender_end_mcap_usd = $9,
          challenger_pct_change = $10, defender_pct_change = $11,
          settlement_version = $12, settlement_scoring_version = $13,
          challenger_battle_points = $14, defender_battle_points = $15,
          challenger_mcap_points = $16, defender_mcap_points = $17,
          challenger_holder_points = $18, defender_holder_points = $19,
          challenger_volume_points = $20, defender_volume_points = $21,
          settlement_metrics_updated_at = $22::timestamptz, settlement_tie_break_used = $23,
          settled_at = $24::timestamptz, finished_at = $24::timestamptz,
          participants = $25::jsonb, updated_at = now()
        where id = $1 and state = 'live' and ends_at is not null and ends_at <= now()
        returning id, chain_id, state, source, challenger_token, defender_token, tournament_id,
                  participants, winner_token, money_winner_token, money_tie_break,
                  mwl_result, mwl_draw, mwl_winner_token, settlement_version,
                  settlement_scoring_version, challenger_battle_points, defender_battle_points,
                  settlement_metrics_updated_at, settlement_tie_break_used, settled_at, finished_at, updated_at`,
      [
        current.id, write.patch.winner_token, write.patch.money_winner_token, write.patch.money_tie_break,
        write.patch.mwl_result, write.patch.mwl_draw, write.patch.mwl_winner_token,
        write.patch.challenger_end_mcap_usd, write.patch.defender_end_mcap_usd,
        write.patch.challenger_pct_change, write.patch.defender_pct_change,
        write.patch.settlement_version, write.patch.settlement_scoring_version,
        write.patch.challenger_battle_points, write.patch.defender_battle_points,
        write.patch.challenger_mcap_points, write.patch.defender_mcap_points,
        write.patch.challenger_holder_points, write.patch.defender_holder_points,
        write.patch.challenger_volume_points, write.patch.defender_volume_points,
        write.patch.settlement_metrics_updated_at, write.patch.settlement_tie_break_used,
        write.patch.settled_at, JSON.stringify(write.patch.participants || []),
      ],
    );
    finished = result.rows[0] || null;
    if (!finished) {
      await client.query("rollback");
      return { settled: false, reason: "settlement_write_lost_race" };
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally { client.release(); }

  if (finished?.tournament_id && decision?.moneyWinnerToken) {
    try {
      await advanceTournamentFromBattle({ ...finished, winner_token: decision.moneyWinnerToken, id: finished.id });
    } catch (error) {
      console.warn("[arena-battle-settlement-v2] tournament advance failed", finished.id, error?.message || error);
    }
  }

  return { settled: true, reason: "ok", battle: finished, decision, finalScore, league };
}
