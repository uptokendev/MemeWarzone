import {
  BATTLE_POINTS_CONFIG,
  BATTLE_POINTS_V3,
  BATTLE_POINTS_V3_BOOST_CURVE,
  BATTLE_POINTS_V3_CONFIG,
  battlePointsV3Enabled,
  battlePointsV3SettlementEnabled,
} from "./arenaBattlePointsConfig.js";
import { calculateBattlePoints } from "./arenaBattlePoints.js";

export const BATTLE_POINTS_V3_PENDING_REASON = "boost_curve_founder_pending";
export const BATTLE_POINTS_V3_SETTLEMENT_DISABLED_REASON = "v3_settlement_disabled";

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundPoints(value) {
  const parsed = finite(value);
  if (parsed === null) return 0;
  return Math.round(parsed * 10_000) / 10_000;
}

function confirmedBoostUnits(value) {
  const raw = String(value ?? "0").trim();
  if (!/^\d+$/.test(raw)) throw new Error("confirmed Boost units must be a non-negative integer");
  const units = BigInt(raw);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("confirmed Boost units exceed safe scoring range");
  return units;
}

export function battlePointsV3MarketConfig(config = BATTLE_POINTS_V3_CONFIG) {
  return Object.freeze({
    version: BATTLE_POINTS_V3,
    staleSeconds: config.staleSeconds,
    mcap: Object.freeze({ ...BATTLE_POINTS_CONFIG.mcap, weight: config.mcap.weight }),
    holders: Object.freeze({ ...BATTLE_POINTS_CONFIG.holders, weight: config.holders.weight }),
    volume: Object.freeze({ ...BATTLE_POINTS_CONFIG.volume, weight: config.volume.weight }),
  });
}

export function battlePointsV3BoostCurveConfigured(config = BATTLE_POINTS_V3_CONFIG) {
  const curveVersion = String(config?.boost?.curveVersion || "").trim();
  const parameters = config?.boost?.curveParameters;
  return curveVersion === BATTLE_POINTS_V3_BOOST_CURVE
    && parameters?.maxPoints === 10
    && parameters?.halfSaturationUnits === 100
    && parameters?.unitUsdMicros === 1_000_000;
}

export function battlePointsV3ActivationStatus({ env = process.env, config = BATTLE_POINTS_V3_CONFIG } = {}) {
  const featureEnabled = battlePointsV3Enabled(env);
  const settlementEnabled = battlePointsV3SettlementEnabled(env);
  const curveConfigured = battlePointsV3BoostCurveConfigured(config);
  if (!featureEnabled) {
    return { active: false, featureEnabled: false, settlementEnabled, curveConfigured, reason: "feature_disabled" };
  }
  if (!curveConfigured) {
    return { active: false, featureEnabled: true, settlementEnabled, curveConfigured: false, reason: BATTLE_POINTS_V3_PENDING_REASON };
  }
  if (!settlementEnabled) {
    return { active: false, featureEnabled: true, settlementEnabled: false, curveConfigured: true, reason: BATTLE_POINTS_V3_SETTLEMENT_DISABLED_REASON };
  }
  return { active: true, featureEnabled: true, settlementEnabled: true, curveConfigured: true, reason: "ok" };
}

/**
 * Founder-locked Boost curve for Battle Points V3.
 * U is the count of confirmed $1 Boost units for one Battle side.
 * Points = 10 * U / (U + 100), asymptotically capped at 10.
 */
export function calculateBattlePointsV3Boost(boostUnits) {
  const units = confirmedBoostUnits(boostUnits);
  if (units === 0n) return 0;
  const u = Number(units);
  return roundPoints((10 * u) / (u + 100));
}

/**
 * Computes the founder-locked market side of Battle Points V3.
 * Existing V2 saturation, holder-confidence and anti-concentration mechanics are
 * reused; only component weights change to 45/27/18. Boost remains a separately
 * confirmed contest-action input so market refreshes cannot invent paid points.
 */
export function calculateBattlePointsV3Market({ boost = {}, ...input } = {}) {
  const config = BATTLE_POINTS_V3_CONFIG;
  const market = calculateBattlePoints({ ...input, config: battlePointsV3MarketConfig(config) });
  const marketSubtotal = roundPoints(market.mcap.points + market.holders.points + market.volume.points);
  const curveConfigured = battlePointsV3BoostCurveConfigured(config);

  return {
    scoringVersion: BATTLE_POINTS_V3,
    totalPoints: null,
    marketSubtotal,
    mcap: market.mcap,
    holders: market.holders,
    volume: market.volume,
    boost: {
      weight: config.boost.weight,
      points: null,
      units: boost.units == null ? "0" : String(boost.units),
      grossNativeRaw: boost.grossNativeRaw == null ? "0" : String(boost.grossNativeRaw),
      poolNativeRaw: boost.poolNativeRaw == null ? "0" : String(boost.poolNativeRaw),
      protocolNativeRaw: boost.protocolNativeRaw == null ? "0" : String(boost.protocolNativeRaw),
      curveVersion: config.boost.curveVersion,
      curveParameters: config.boost.curveParameters,
    },
    components: {
      mcapPoints: market.mcap.points,
      holderPoints: market.holders.points,
      volumePoints: market.volume.points,
      boostPoints: null,
    },
    performance: market.performance,
    marketDataUpdatedAt: market.marketDataUpdatedAt,
    dataHealth: market.dataHealth,
    settleable: false,
    settlementReason: curveConfigured ? "boost_points_not_calculated" : BATTLE_POINTS_V3_PENDING_REASON,
  };
}

export function combineBattlePointsV3({
  marketScore,
  boostPoints,
  curveVersion = BATTLE_POINTS_V3_CONFIG.boost.curveVersion,
  curveParameters = BATTLE_POINTS_V3_CONFIG.boost.curveParameters,
} = {}) {
  if (!marketScore || marketScore.scoringVersion !== BATTLE_POINTS_V3) {
    throw new Error("Battle Points V3 market score is required");
  }
  if (String(curveVersion || "").trim() !== BATTLE_POINTS_V3_BOOST_CURVE) {
    throw new Error("Battle Points V3 Boost curve version mismatch");
  }
  if (
    curveParameters?.maxPoints !== 10
    || curveParameters?.halfSaturationUnits !== 100
    || curveParameters?.unitUsdMicros !== 1_000_000
  ) {
    throw new Error("Battle Points V3 Boost curve parameters mismatch");
  }
  const points = finite(boostPoints);
  if (points === null || points < 0 || points > BATTLE_POINTS_V3_CONFIG.boost.weight) {
    throw new Error("Battle Points V3 Boost points must be between 0 and 10");
  }
  if (marketScore.dataHealth?.healthy !== true) {
    throw new Error("Battle Points V3 market data is unhealthy");
  }

  const marketSubtotal = roundPoints(marketScore.marketSubtotal);
  const totalPoints = roundPoints(Math.min(100, marketSubtotal + points));
  return {
    ...marketScore,
    totalPoints,
    boost: {
      ...marketScore.boost,
      points: roundPoints(points),
      curveVersion: BATTLE_POINTS_V3_BOOST_CURVE,
      curveParameters: BATTLE_POINTS_V3_CONFIG.boost.curveParameters,
    },
    components: {
      ...marketScore.components,
      boostPoints: roundPoints(points),
    },
    settleable: true,
    settlementReason: "ok",
  };
}

export function calculateBattlePointsV3({ boost = {}, ...input } = {}) {
  const marketScore = calculateBattlePointsV3Market({ boost, ...input });
  const boostPoints = calculateBattlePointsV3Boost(boost.units ?? 0);
  return combineBattlePointsV3({ marketScore, boostPoints });
}
