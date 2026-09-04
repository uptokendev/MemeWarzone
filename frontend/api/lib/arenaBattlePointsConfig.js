export const BATTLE_POINTS_V1 = "mcap_pct_change";
export const BATTLE_POINTS_V2 = "battle_points_v2";
export const BATTLE_POINTS_V3 = "battle_points_v3";
export const BATTLE_POINTS_V3_BOOST_CURVE = "boost_hyperbolic_100_v1";

export const BATTLE_POINTS_CONFIG = Object.freeze({
  version: BATTLE_POINTS_V2,
  staleSeconds: 120,
  mcap: Object.freeze({ weight: 50, k: 4.0 }),
  holders: Object.freeze({ weight: 30, k: 3.0, confidenceFloor: 50 }),
  volume: Object.freeze({
    weight: 20,
    k: 8.0,
    singleClusterCap: 0.2,
    minMcapDenom: 1000,
  }),
});

export const BATTLE_POINTS_V3_CONFIG = Object.freeze({
  version: BATTLE_POINTS_V3,
  staleSeconds: 120,
  mcap: Object.freeze({ weight: 45 }),
  holders: Object.freeze({ weight: 27 }),
  volume: Object.freeze({ weight: 18 }),
  boost: Object.freeze({
    weight: 10,
    curveVersion: BATTLE_POINTS_V3_BOOST_CURVE,
    curveParameters: Object.freeze({
      maxPoints: 10,
      halfSaturationUnits: 100,
      unitUsdMicros: 1_000_000,
    }),
  }),
});

export function battlePointsV2PersistenceEnabled(env = process.env) {
  const raw = String(env.ARENA_BATTLE_POINTS_V2 || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function battlePointsV3Enabled(env = process.env) {
  const raw = String(env.ARENA_BATTLE_POINTS_V3 || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function battlePointsV3SettlementEnabled(env = process.env) {
  const raw = String(env.ARENA_BATTLE_POINTS_V3_SETTLEMENT || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
