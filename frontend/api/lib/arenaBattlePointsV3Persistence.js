import { BATTLE_POINTS_V3_CONFIG } from "./arenaBattlePointsConfig.js";

async function defaultQuery(text, params) {
  const { pool } = await import("../../server/db.js");
  return pool.query(text, params);
}

/**
 * Persists the market-performance projection for Battle Points V3 while leaving
 * confirmed Boost money/units under contest-action ingestion ownership. The
 * curve identity is written on first insert and deliberately never overwritten
 * by refreshes; production settlement additionally requires the immutable
 * per-Battle scoring lock.
 */
export async function persistBattlePointsV3MarketProjection({
  battleId,
  tokenId,
  side,
  score,
}, deps = {}) {
  if (!battleId || !tokenId || !["left", "right"].includes(String(side))) {
    throw new Error("Battle Points V3 projection identity is invalid");
  }
  if (!score || score.scoringVersion !== "battle_points_v3") {
    throw new Error("Battle Points V3 market score is required");
  }

  const query = deps.query || defaultQuery;
  const config = BATTLE_POINTS_V3_CONFIG;
  const params = [
    String(battleId),
    String(tokenId),
    String(side),
    config.mcap.weight,
    config.holders.weight,
    config.volume.weight,
    config.boost.weight,
    String(config.boost.curveVersion),
    JSON.stringify(config.boost.curveParameters || {}),
    score.mcap?.points ?? null,
    score.holders?.points ?? null,
    score.volume?.points ?? null,
  ];

  const result = await query(
    `insert into public.arena_battle_points_v3 (
       battle_id, token_id, side,
       mcap_weight, holder_weight, volume_weight, boost_weight,
       boost_curve_version, boost_curve_parameters,
       mcap_points, holder_points, volume_points,
       boost_points, total_points, metrics_updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,null,null,now())
     on conflict (battle_id, side) do update set
       token_id = excluded.token_id,
       mcap_weight = excluded.mcap_weight,
       holder_weight = excluded.holder_weight,
       volume_weight = excluded.volume_weight,
       boost_weight = excluded.boost_weight,
       mcap_points = excluded.mcap_points,
       holder_points = excluded.holder_points,
       volume_points = excluded.volume_points,
       metrics_updated_at = now(),
       updated_at = now()
     returning battle_id, token_id, side, scoring_version,
               mcap_weight, holder_weight, volume_weight, boost_weight,
               boost_curve_version, boost_curve_parameters,
               boost_units, boost_gross_native_raw, boost_pool_native_raw,
               boost_protocol_native_raw, boost_points, mcap_points,
               holder_points, volume_points, total_points, metrics_updated_at`,
    params,
  );

  const row = result?.rows?.[0] || null;
  if (row && (
    String(row.boost_curve_version || "") !== String(config.boost.curveVersion)
    || Number(row.boost_curve_parameters?.maxPoints) !== 10
    || Number(row.boost_curve_parameters?.halfSaturationUnits) !== 100
    || Number(row.boost_curve_parameters?.unitUsdMicros) !== 1_000_000
  )) {
    throw new Error("Battle Points V3 projection has an incompatible immutable Boost curve");
  }
  return row;
}
