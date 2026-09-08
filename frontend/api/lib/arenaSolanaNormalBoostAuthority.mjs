import { calculateBattlePointsV3Boost } from "./arenaBattlePointsV3.js";
import {
  exactBattlePointsV3Lock,
  projectBattlePointsV3Row,
  resolveBattlePointsV3BoostSaleStatus,
} from "./arenaBoostRuntime.mjs";

export function normalBattleRegulationOpen(battle, now = Date.now()) {
  const endMs = battle?.ends_at ? Date.parse(battle.ends_at) : Number.NaN;
  return Number.isFinite(endMs) && Number(now) < endMs;
}

export async function loadNormalBattleV3SaleAuthority({ battle, db, env = process.env, now = Date.now() }) {
  if (!battle?.id) return { active: false, reason: "historical_scoring_generation", lock: null, projections: [] };
  const [lockResult, scoringResult, metricsResult] = await Promise.all([
    db.query(
      `select battle_id,scoring_version,boost_curve_version,boost_curve_parameters,locked_at
         from public.arena_battle_scoring_locks where battle_id=$1 limit 1`,
      [String(battle.id)],
    ),
    db.query(
      `select battle_id,token_id,side,scoring_version,mcap_weight,holder_weight,volume_weight,boost_weight,
              boost_curve_version,boost_curve_parameters,boost_units,boost_gross_native_raw,boost_pool_native_raw,
              boost_protocol_native_raw,boost_points,mcap_points,holder_points,volume_points,total_points,
              metrics_updated_at,updated_at
         from public.arena_battle_points_v3 where battle_id=$1
        order by case side when 'left' then 0 else 1 end`,
      [String(battle.id)],
    ),
    db.query(
      `select battle_id,side,data_healthy,data_lag_seconds,market_data_updated_at,metrics_updated_at
         from public.arena_battle_metrics where battle_id=$1`,
      [String(battle.id)],
    ),
  ]);
  const lock = lockResult.rows[0] || null;
  if (!exactBattlePointsV3Lock(lock)) return { active: false, reason: "historical_scoring_generation", lock, projections: [] };
  const metrics = new Map((metricsResult.rows || []).map((row) => [String(row.side), row]));
  const projections = (scoringResult.rows || []).map((row) => {
    const projected = projectBattlePointsV3Row(row, metrics.get(String(row.side)) || null, { now });
    return { side: String(row.side), row, ...projected };
  });
  const sale = resolveBattlePointsV3BoostSaleStatus({ battle, lock, projections, env });
  return { ...sale, lock, projections };
}

export function validateHistoricalNormalPaymentIdentity({ route, quote, battle, targetToken, side, competitionId }) {
  if (!quote || quote.product_kind !== "normal_battle") return { ok: false, reason: "product" };
  if (!battle || String(battle.id) !== String(route?.battleId) || String(quote.battle_id) !== String(route?.battleId)) return { ok: false, reason: "battle" };
  if (Number(battle.chain_id) !== Number(quote.chain_id)) return { ok: false, reason: "chain" };
  if (String(battle.battle_mode || "normal") !== "normal" || String(battle.source || "") === "tournament") return { ok: false, reason: "product" };
  if (String(battle.competition_generation || "") !== "arena_competition_v2") return { ok: false, reason: "competition_generation" };
  if (String(targetToken) !== String(quote.target_token)) return { ok: false, reason: "token" };
  if (String(side) !== String(quote.side)) return { ok: false, reason: "side" };
  if (String(competitionId).toLowerCase() !== String(quote.competition_id || "").toLowerCase()) return { ok: false, reason: "competition" };
  if (!quote.wallet || !quote.funding_id || !quote.id || !quote.signature_reference || !quote.receipt_pda) return { ok: false, reason: "payment_identity" };
  return { ok: true };
}

export async function applyConfirmedNormalBattleBoostV3(client, quote, { now = Date.now() } = {}) {
  const lock = (await client.query(
    `select battle_id,scoring_version,boost_curve_version,boost_curve_parameters,locked_at
       from public.arena_battle_scoring_locks where battle_id=$1 limit 1`,
    [String(quote.battle_id)],
  )).rows[0] || null;
  if (!exactBattlePointsV3Lock(lock)) return { updated: false, reason: "historical_scoring_generation" };

  const row = (await client.query(
    `select battle_id,token_id,side,scoring_version,mcap_weight,holder_weight,volume_weight,boost_weight,
            boost_curve_version,boost_curve_parameters,boost_units,boost_gross_native_raw,boost_pool_native_raw,
            boost_protocol_native_raw,boost_points,mcap_points,holder_points,volume_points,total_points,
            metrics_updated_at,updated_at
       from public.arena_battle_points_v3 where battle_id=$1 and side=$2 for update`,
    [String(quote.battle_id), String(quote.side)],
  )).rows[0] || null;
  if (!row) return { updated: false, reason: "v3_projection_missing" };

  const metric = (await client.query(
    `select battle_id,side,data_healthy,data_lag_seconds,market_data_updated_at,metrics_updated_at
       from public.arena_battle_metrics where battle_id=$1 and side=$2 limit 1`,
    [String(quote.battle_id), String(quote.side)],
  )).rows[0] || null;
  const before = projectBattlePointsV3Row(row, metric, { now });
  if (before.projectionValid !== true) return { updated: false, reason: "v3_projection_incompatible" };

  const boostUnits = BigInt(String(row.boost_units || 0)) + BigInt(String(quote.boost_units));
  const gross = BigInt(String(row.boost_gross_native_raw || 0)) + BigInt(String(quote.gross_lamports));
  const prize = BigInt(String(row.boost_pool_native_raw || 0)) + BigInt(String(quote.prize_lamports));
  const protocol = BigInt(String(row.boost_protocol_native_raw || 0)) + BigInt(String(quote.protocol_lamports));
  const projectedRow = {
    ...row,
    boost_units: boostUnits.toString(),
    boost_gross_native_raw: gross.toString(),
    boost_pool_native_raw: prize.toString(),
    boost_protocol_native_raw: protocol.toString(),
  };
  const projected = projectBattlePointsV3Row(projectedRow, metric, { now });
  const boostPoints = calculateBattlePointsV3Boost(boostUnits);
  const totalPoints = projected.scoringReady === true ? projected.totalPoints : row.total_points;
  const updated = (await client.query(
    `update public.arena_battle_points_v3
        set boost_units=$3,boost_gross_native_raw=$4,boost_pool_native_raw=$5,boost_protocol_native_raw=$6,
            boost_points=$7,total_points=$8,updated_at=now()
      where battle_id=$1 and side=$2
        and scoring_version=$9 and boost_curve_version=$10
      returning *`,
    [String(quote.battle_id), String(quote.side), boostUnits.toString(), gross.toString(), prize.toString(), protocol.toString(), boostPoints, totalPoints, String(lock.scoring_version), String(lock.boost_curve_version)],
  )).rows[0] || null;
  return updated ? { updated: true, row: updated, boostPoints, totalPoints } : { updated: false, reason: "v3_projection_changed" };
}
