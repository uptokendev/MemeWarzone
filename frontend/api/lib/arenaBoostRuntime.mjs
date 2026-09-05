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

export const BPS_DENOM = 10_000n;
export const BOOST_POOL_BPS = 9_000n;
export const BOOST_PROTOCOL_BPS = 1_000n;

export function parseRawNative(value, label = "amount") {
  try {
    const raw = BigInt(String(value));
    if (raw < 0n) throw new Error(`${label} must be non-negative`);
    return raw;
  } catch (error) {
    if (error instanceof Error && /non-negative/.test(error.message)) throw error;
    throw new Error(`${label} must be an integer raw native amount`);
  }
}

export function expectedBoostSplit(grossNativeRaw) {
  const gross = parseRawNative(grossNativeRaw, "grossNativeRaw");
  if (gross <= 0n) throw new Error("grossNativeRaw must be positive");
  const protocol = (gross * BOOST_PROTOCOL_BPS) / BPS_DENOM;
  const pool = gross - protocol;
  return { gross, pool, protocol };
}

export function validateConfirmedBoost({ boostUnits, grossNativeRaw, poolNativeRaw, protocolNativeRaw }) {
  const units = parseRawNative(boostUnits, "boostUnits");
  if (units <= 0n) throw new Error("boostUnits must be positive");
  const expected = expectedBoostSplit(grossNativeRaw);
  const pool = parseRawNative(poolNativeRaw, "poolNativeRaw");
  const protocol = parseRawNative(protocolNativeRaw, "protocolNativeRaw");
  if (pool !== expected.pool || protocol !== expected.protocol) {
    throw new Error("Boost split must be exactly 90% prize / 10% protocol with integer dust retained by prize");
  }
  return { boostUnits: units, ...expected };
}

export function resolveBattleSide(participants, targetToken) {
  const needle = String(targetToken || "").trim().toLowerCase();
  if (!needle || !Array.isArray(participants) || participants.length < 2) return null;
  const identity = (participant) =>
    String(participant?.tokenId || participant?.tokenAddress || participant?.campaignAddress || "").trim().toLowerCase();
  if (identity(participants[0]) === needle) return "left";
  if (identity(participants[1]) === needle) return "right";
  return null;
}

export function boostSummary(rows = []) {
  const summary = {
    left: { boostUnits: 0n, grossNativeRaw: 0n, poolNativeRaw: 0n, protocolNativeRaw: 0n },
    right: { boostUnits: 0n, grossNativeRaw: 0n, poolNativeRaw: 0n, protocolNativeRaw: 0n },
    total: { boostUnits: 0n, grossNativeRaw: 0n, poolNativeRaw: 0n, protocolNativeRaw: 0n },
  };
  for (const row of rows) {
    const side = row?.side === "right" ? "right" : row?.side === "left" ? "left" : null;
    if (!side) continue;
    const units = parseRawNative(row.boost_units ?? 0, "boost_units");
    const gross = parseRawNative(row.gross_native_raw ?? 0, "gross_native_raw");
    const pool = parseRawNative(row.pool_native_raw ?? 0, "pool_native_raw");
    const protocol = parseRawNative(row.protocol_native_raw ?? 0, "protocol_native_raw");
    summary[side].boostUnits += units;
    summary[side].grossNativeRaw += gross;
    summary[side].poolNativeRaw += pool;
    summary[side].protocolNativeRaw += protocol;
    summary.total.boostUnits += units;
    summary.total.grossNativeRaw += gross;
    summary.total.poolNativeRaw += pool;
    summary.total.protocolNativeRaw += protocol;
  }
  return summary;
}

export function serializeBoostSummary(summary) {
  const encode = (bucket) => ({
    boostUnits: bucket.boostUnits.toString(),
    grossNativeRaw: bucket.grossNativeRaw.toString(),
    poolNativeRaw: bucket.poolNativeRaw.toString(),
    protocolNativeRaw: bucket.protocolNativeRaw.toString(),
  });
  return { left: encode(summary.left), right: encode(summary.right), total: encode(summary.total) };
}

function exactCurveParameters(parameters) {
  return Boolean(
    parameters
    && Number(parameters.maxPoints) === BATTLE_POINTS_V3_CONFIG.boost.curveParameters.maxPoints
    && Number(parameters.halfSaturationUnits) === BATTLE_POINTS_V3_CONFIG.boost.curveParameters.halfSaturationUnits
    && Number(parameters.unitUsdMicros) === BATTLE_POINTS_V3_CONFIG.boost.curveParameters.unitUsdMicros
  );
}

export function exactBattlePointsV3Lock(lock) {
  return Boolean(
    lock
    && String(lock.scoring_version || "") === BATTLE_POINTS_V3
    && String(lock.boost_curve_version || "") === BATTLE_POINTS_V3_BOOST_CURVE
    && exactCurveParameters(lock.boost_curve_parameters)
  );
}

function exactBattlePointsV3Projection(row) {
  return Boolean(
    row
    && String(row.scoring_version || "") === BATTLE_POINTS_V3
    && Number(row.mcap_weight) === BATTLE_POINTS_V3_CONFIG.mcap.weight
    && Number(row.holder_weight) === BATTLE_POINTS_V3_CONFIG.holders.weight
    && Number(row.volume_weight) === BATTLE_POINTS_V3_CONFIG.volume.weight
    && Number(row.boost_weight) === BATTLE_POINTS_V3_CONFIG.boost.weight
    && String(row.boost_curve_version || "") === BATTLE_POINTS_V3_BOOST_CURVE
    && exactCurveParameters(row.boost_curve_parameters)
  );
}

function finitePoint(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function metricHealth(metricRow, now = Date.now()) {
  if (!metricRow) {
    return { healthy: false, status: "missing", reason: "battle_metrics_missing", dataLagSeconds: null, marketDataUpdatedAt: null };
  }
  const updatedAt = metricRow.market_data_updated_at || metricRow.metrics_updated_at || null;
  const updatedMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  const derivedLag = Number.isFinite(updatedMs) ? Math.max(0, (Number(now) - updatedMs) / 1000) : null;
  const storedLag = Number(metricRow.data_lag_seconds);
  const dataLagSeconds = derivedLag ?? (Number.isFinite(storedLag) ? Math.max(0, storedLag) : null);
  if (metricRow.data_healthy !== true) {
    return { healthy: false, status: "missing", reason: "market_data_unhealthy", dataLagSeconds, marketDataUpdatedAt: updatedAt };
  }
  if (dataLagSeconds === null) {
    return { healthy: false, status: "missing", reason: "market_data_timestamp_missing", dataLagSeconds, marketDataUpdatedAt: updatedAt };
  }
  if (dataLagSeconds > BATTLE_POINTS_V3_CONFIG.staleSeconds) {
    return { healthy: false, status: "stale", reason: "stale", dataLagSeconds, marketDataUpdatedAt: updatedAt };
  }
  return { healthy: true, status: "healthy", reason: null, dataLagSeconds, marketDataUpdatedAt: updatedAt };
}

export function projectBattlePointsV3Row(row, metricRow, { now = Date.now() } = {}) {
  const dataHealth = metricHealth(metricRow, now);
  const projection = {
    projectionValid: false,
    scoringReady: false,
    reason: "v3_projection_incompatible",
    boostPoints: null,
    totalPoints: null,
    dataHealth,
  };
  if (!exactBattlePointsV3Projection(row)) return projection;

  const mcapPoints = finitePoint(row.mcap_points);
  const holderPoints = finitePoint(row.holder_points);
  const volumePoints = finitePoint(row.volume_points);
  const boostPoints = calculateBattlePointsV3Boost(row.boost_units ?? 0);
  projection.projectionValid = true;
  projection.boostPoints = boostPoints;

  if (mcapPoints === null || holderPoints === null || volumePoints === null) {
    projection.reason = "v3_projection_incomplete";
    return projection;
  }
  if (!dataHealth.healthy) {
    projection.reason = "data_delay";
    return projection;
  }

  const marketScore = {
    scoringVersion: BATTLE_POINTS_V3,
    marketSubtotal: mcapPoints + holderPoints + volumePoints,
    mcap: { points: mcapPoints },
    holders: { points: holderPoints },
    volume: { points: volumePoints },
    boost: {
      weight: BATTLE_POINTS_V3_CONFIG.boost.weight,
      points: null,
      units: String(row.boost_units ?? 0),
      grossNativeRaw: String(row.boost_gross_native_raw ?? 0),
      poolNativeRaw: String(row.boost_pool_native_raw ?? 0),
      protocolNativeRaw: String(row.boost_protocol_native_raw ?? 0),
      curveVersion: row.boost_curve_version,
      curveParameters: row.boost_curve_parameters,
    },
    components: { mcapPoints, holderPoints, volumePoints, boostPoints: null },
    dataHealth,
    settleable: false,
    settlementReason: "boost_points_not_calculated",
  };
  const combined = combineBattlePointsV3({
    marketScore,
    boostPoints,
    curveVersion: row.boost_curve_version,
    curveParameters: row.boost_curve_parameters,
  });
  projection.scoringReady = true;
  projection.reason = "ok";
  projection.boostPoints = combined.boost.points;
  projection.totalPoints = combined.totalPoints;
  return projection;
}

function normalizedActivationReason(status) {
  if (!status?.curveConfigured) return "boost_curve_configuration_invalid";
  return status?.reason || "v3_scoring_inactive";
}

function normalCompetitionV2Battle(battle) {
  return Boolean(
    battle
    && String(battle.battle_mode || "normal") === "normal"
    && String(battle.source || "") !== "tournament"
    && String(battle.competition_generation || "") === "arena_competition_v2"
  );
}

export function resolveBattlePointsV3BoostSaleStatus({ battle, lock, projections = [], env = process.env } = {}) {
  if (!normalCompetitionV2Battle(battle)) return { active: false, reason: "incompatible_battle_generation" };
  if (String(battle.state || "") !== "live") return { active: false, reason: "battle_not_live" };
  if (!exactBattlePointsV3Lock(lock)) return { active: false, reason: "historical_scoring_generation" };
  const activation = battlePointsV3ActivationStatus({ env });
  if (!activation.active) return { active: false, reason: normalizedActivationReason(activation), activation };
  const bySide = new Map((projections || []).map((entry) => [String(entry?.side || ""), entry]));
  if (!bySide.get("left") || !bySide.get("right")) return { active: false, reason: "v3_projection_incomplete", activation };
  if ([bySide.get("left"), bySide.get("right")].some((entry) => entry.projectionValid !== true)) {
    return { active: false, reason: "v3_projection_incompatible", activation };
  }
  return { active: true, reason: "ok", activation };
}

export function resolveBattlePointsV3Authority({ battle, lock, projections = [], env = process.env } = {}) {
  const sale = resolveBattlePointsV3BoostSaleStatus({ battle, lock, projections, env });
  if (!sale.active) return sale;
  const bySide = new Map((projections || []).map((entry) => [String(entry?.side || ""), entry]));
  const delayed = [bySide.get("left"), bySide.get("right")].find((entry) => entry.scoringReady !== true);
  if (delayed) return { active: false, reason: delayed.reason || "data_delay", activation: sale.activation };
  return { active: true, reason: "ok", activation: sale.activation };
}
