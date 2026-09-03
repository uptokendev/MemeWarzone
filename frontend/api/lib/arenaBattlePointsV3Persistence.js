import { BATTLE_POINTS_V3_CONFIG } from "./arenaBattlePointsConfig.js";

async function defaultQuery(text, params) {
  const { pool } = await import("../../server/db.js");
  return pool.query(text, params);
}

/**
 * Persists only the market-performance projection for Battle Points V3.
 * Boost units/raw money remain owned by confirmed contest-action ingestion.
 * boost_points and total_points remain untouched until the founder locks a
 * versioned Boost conversion curve and V3 settlement is separately enabled.
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
       boost_curve_version = excluded.boost_curve_version,
       boost_curve_parameters = excluded.boost_curve_parameters,
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

  return result?.rows?.[0] || null;
}
