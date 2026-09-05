import { pool } from "../../server/db.js";
import { battleLeagueEligibility } from "./arenaBattleCompetition.js";
import {
  BATTLE_POINTS_V3,
  BATTLE_POINTS_V3_BOOST_CURVE,
  BATTLE_POINTS_V3_CONFIG,
} from "./arenaBattlePointsConfig.js";
import {
  battlePointsV3ActivationStatus,
  calculateBattlePointsV3Boost,
  combineBattlePointsV3,
} from "./arenaBattlePointsV3.js";
import { reconcileBattlePointsAtClose } from "./arenaBattleFinalScore.js";
import { battleSettlementPatch, decorateSettledParticipants } from "./arenaBattleSettle.js";
import { decideBattlePointsV3Settlement } from "./arenaBattleSettleV3.js";
import { recordFinishedBattle } from "./arenaLeagueScore.js";

const SETTLE_COLUMNS = `id, chain_id, state, source, battle_mode, competition_generation,
  challenger_token, defender_token, tournament_id, participants, started_at, ends_at,
  created_at, updated_at`;

function exactCurveLock(lock) {
  const params = lock?.boost_curve_parameters || {};
  return Boolean(
    lock
    && lock.scoring_version === BATTLE_POINTS_V3
    && lock.boost_curve_version === BATTLE_POINTS_V3_BOOST_CURVE
    && Number(params.maxPoints) === BATTLE_POINTS_V3_CONFIG.boost.curveParameters.maxPoints
    && Number(params.halfSaturationUnits) === BATTLE_POINTS_V3_CONFIG.boost.curveParameters.halfSaturationUnits
    && Number(params.unitUsdMicros) === BATTLE_POINTS_V3_CONFIG.boost.curveParameters.unitUsdMicros
  );
}

function v3Side(marketSide, row, lock) {
  if (!row || String(row.boost_curve_version || "") !== lock.boost_curve_version) {
    throw new Error("v3_projection_curve_mismatch");
  }
  const params = row.boost_curve_parameters || {};
  if (
    Number(params.maxPoints) !== 10
    || Number(params.halfSaturationUnits) !== 100
    || Number(params.unitUsdMicros) !== 1_000_000
  ) throw new Error("v3_projection_curve_parameters_mismatch");
  const boostPoints = calculateBattlePointsV3Boost(row.boost_units || 0);
  const marketScore = {
    ...marketSide,
    scoringVersion: BATTLE_POINTS_V3,
    marketSubtotal: Number(row.mcap_points || 0) + Number(row.holder_points || 0) + Number(row.volume_points || 0),
    mcap: { ...marketSide.mcap, points: Number(row.mcap_points || 0) },
    holders: { ...marketSide.holders, points: Number(row.holder_points || 0) },
    volume: { ...marketSide.volume, points: Number(row.volume_points || 0) },
    components: {
      mcapPoints: Number(row.mcap_points || 0),
      holderPoints: Number(row.holder_points || 0),
      volumePoints: Number(row.volume_points || 0),
      boostPoints: null,
    },
    boost: {
      weight: Number(row.boost_weight || 10),
      points: null,
      units: String(row.boost_units || 0),
      grossNativeRaw: String(row.boost_gross_native_raw || 0),
      poolNativeRaw: String(row.boost_pool_native_raw || 0),
      protocolNativeRaw: String(row.boost_protocol_native_raw || 0),
      curveVersion: row.boost_curve_version,
      curveParameters: row.boost_curve_parameters,
    },
    settleable: false,
    settlementReason: "boost_points_not_calculated",
  };
  return combineBattlePointsV3({
    marketScore,
    boostPoints,
    curveVersion: lock.boost_curve_version,
    curveParameters: lock.boost_curve_parameters,
  });
}

export function battlePointsV3SettlementRuntimeEnabled(env = process.env) {
  return battlePointsV3ActivationStatus({ env }).active;
}

export async function settleBattlePointsV3ById(battleId, deps = {}) {
  const env = deps.env || process.env;
  if (!deps.force && !battlePointsV3SettlementRuntimeEnabled(env)) {
    return { settled: false, reason: "battle_points_v3_settlement_disabled" };
  }
  const db = deps.pool || pool;
  const client = await db.connect();
  let finished = null;
  let decision = null;
  let finalScore = null;
  let league = null;
  try {
    await client.query("begin");
    const locked = await client.query(
      `select ${SETTLE_COLUMNS}
         from public.arena_battles b
        where b.id = $1
          and b.state = 'live'
          and coalesce(b.battle_mode, 'normal') = 'normal'
          and b.source <> 'tournament'
          and b.competition_generation = 'arena_competition_v2'
          and b.ends_at is not null
          and b.ends_at <= now()
        for update`,
      [String(battleId)],
    );
    const current = locked.rows[0];
    if (!current) {
      await client.query("commit");
      return { settled: false, reason: "not_due_or_not_explicit_v3_candidate" };
    }

    const lock = (await client.query(
      `select battle_id, scoring_version, boost_curve_version, boost_curve_parameters, locked_at
         from public.arena_battle_scoring_locks
        where battle_id = $1`,
      [String(battleId)],
    )).rows[0];
    if (!exactCurveLock(lock)) {
      await client.query("rollback");
      return { settled: false, reason: "missing_or_incompatible_v3_scoring_lock" };
    }

    const query = (text, params) => client.query(text, params);
    finalScore = await reconcileBattlePointsAtClose(current, {
      query,
      env: { ...env, ARENA_BATTLE_POINTS_V3: "true" },
      getSnapshot: deps.getSnapshot,
      nativeUsd: deps.nativeUsd,
      resolveNativeUsd: deps.resolveNativeUsd,
    });
    if (!finalScore.ok) {
      await client.query("rollback");
      return { settled: false, reason: finalScore.reason, dataDelay: true, side: finalScore.side || null };
    }

    const projections = (await client.query(
      `select battle_id, token_id, side, scoring_version,
              mcap_weight, holder_weight, volume_weight, boost_weight,
              boost_curve_version, boost_curve_parameters,
              boost_units, boost_gross_native_raw, boost_pool_native_raw, boost_protocol_native_raw,
              mcap_points, holder_points, volume_points
         from public.arena_battle_points_v3
        where battle_id = $1
        order by side asc`,
      [String(battleId)],
    )).rows || [];
    const bySide = new Map(projections.map((row) => [String(row.side), row]));
    if (projections.length !== 2 || !bySide.get("left") || !bySide.get("right")) {
      await client.query("rollback");
      return { settled: false, reason: "v3_projection_incomplete", dataDelay: true };
    }

    let leftScored;
    let rightScored;
    try {
      leftScored = v3Side(finalScore.sides.left, bySide.get("left"), lock);
      rightScored = v3Side(finalScore.sides.right, bySide.get("right"), lock);
    } catch (error) {
      await client.query("rollback");
      return { settled: false, reason: String(error?.message || error), dataDelay: true };
    }

    decision = decideBattlePointsV3Settlement({
      leftToken: current.challenger_token,
      rightToken: current.defender_token,
      leftScored,
      rightScored,
    });
    if (!decision.ok) {
      await client.query("rollback");
      return { settled: false, reason: decision.reason, dataDelay: true };
    }

    const participants = decorateSettledParticipants(current.participants, decision);
    league = battleLeagueEligibility({ ...current, participants });
    if (league.eligible) {
      await recordFinishedBattle({
        ...current,
        mwlDraw: decision.mwlDraw,
        mwlWinnerToken: decision.mwlWinnerToken,
        mwlResult: decision.mwlResult,
        participants,
      }, client);
    }

    const settledAt = new Date().toISOString();
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
          settlement_metrics_updated_at = $22::timestamptz,
          settlement_tie_break_used = $23, settled_at = $24::timestamptz,
          finished_at = $24::timestamptz, participants = $25::jsonb, updated_at = now()
        where id = $1 and state = 'live'
        returning id, chain_id, state, source, challenger_token, defender_token, tournament_id,
                  participants, winner_token, money_winner_token, money_tie_break,
                  mwl_result, mwl_draw, mwl_winner_token, settlement_version,
                  settlement_scoring_version, challenger_battle_points, defender_battle_points,
                  settlement_metrics_updated_at, settlement_tie_break_used,
                  settled_at, finished_at, updated_at`,
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
    return { settled: true, reason: "ok", battle: finished, decision, finalScore, league, scoringLock: lock, sides: { left: leftScored, right: rightScored } };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
