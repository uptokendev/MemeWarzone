import {
  BATTLE_POINTS_CONFIG,
  BATTLE_POINTS_V3,
  BATTLE_POINTS_V3_CONFIG,
  battlePointsV3Enabled,
} from "./arenaBattlePointsConfig.js";
import { calculateBattlePoints } from "./arenaBattlePoints.js";

export const BATTLE_POINTS_V3_PENDING_REASON = "boost_curve_founder_pending";

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
  if (!curveVersion || curveVersion === "founder_pending") return false;
  return Boolean(config?.boost?.curveParameters && typeof config.boost.curveParameters === "object");
}

export function battlePointsV3ActivationStatus({ env = process.env, config = BATTLE_POINTS_V3_CONFIG } = {}) {
  const featureEnabled = battlePointsV3Enabled(env);
  const curveConfigured = battlePointsV3BoostCurveConfigured(config);
  if (!featureEnabled) {
    return { active: false, featureEnabled: false, curveConfigured, reason: "feature_disabled" };
  }
  if (!curveConfigured) {
    return { active: false, featureEnabled: true, curveConfigured: false, reason: BATTLE_POINTS_V3_PENDING_REASON };
  }
  return { active: true, featureEnabled: true, curveConfigured: true, reason: "ok" };
}

/**
 * Computes only the founder-locked market side of Battle Points V3.
 * Existing V2 saturation, holder-confidence and anti-concentration mechanics are
 * reused; only component weights change to 45/27/18. The result intentionally
 * remains non-settleable until the independent 10-point Boost curve is locked.
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

/**
 * Combines a V3 market score with Boost points produced by a separately locked
 * and versioned curve implementation. This function never derives Boost points.
 */
export function combineBattlePointsV3({ marketScore, boostPoints, curveVersion, curveParameters = {} } = {}) {
  if (!marketScore || marketScore.scoringVersion !== BATTLE_POINTS_V3) {
    throw new Error("Battle Points V3 market score is required");
  }
  const configuredVersion = String(curveVersion || "").trim();
  if (!configuredVersion || configuredVersion === "founder_pending") {
    throw new Error(BATTLE_POINTS_V3_PENDING_REASON);
  }
  if (!curveParameters || typeof curveParameters !== "object" || Array.isArray(curveParameters)) {
    throw new Error("Battle Points V3 Boost curve parameters are invalid");
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
      curveVersion: configuredVersion,
      curveParameters,
    },
    components: {
      ...marketScore.components,
      boostPoints: roundPoints(points),
    },
    settleable: true,
    settlementReason: "ok",
  };
}
