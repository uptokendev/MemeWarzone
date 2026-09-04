import assert from "node:assert/strict";
import test from "node:test";
import "./arenaBattlePointsV3Persistence.test.mjs";
import "./arenaBattlePointsV3Refresh.test.mjs";

import {
  BATTLE_POINTS_V3,
  BATTLE_POINTS_V3_BOOST_CURVE,
  BATTLE_POINTS_V3_CONFIG,
} from "./arenaBattlePointsConfig.js";
import {
  BATTLE_POINTS_V3_SETTLEMENT_DISABLED_REASON,
  battlePointsV3ActivationStatus,
  battlePointsV3MarketConfig,
  calculateBattlePointsV3,
  calculateBattlePointsV3Boost,
  calculateBattlePointsV3Market,
  combineBattlePointsV3,
} from "./arenaBattlePointsV3.js";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");

function clusters(total, count = 5) {
  return Array.from({ length: count }, (_, index) => ({
    clusterId: `cluster-${index + 1}`,
    countedUsd: total / count,
  }));
}

function score(overrides = {}) {
  return calculateBattlePointsV3Market({
    baseline: {
      startMcapUsd: 10_000,
      startHolders: 1_000,
      baselineTimestamp: "2026-09-02T12:00:00.000Z",
      ...(overrides.baseline || {}),
    },
    current: {
      marketCapUsd: 12_000,
      holders: 1_200,
      updatedAt: "2026-09-03T11:59:00.000Z",
      healthy: true,
      ...(overrides.current || {}),
    },
    eligibleVolume: {
      usd: 20_000,
      rawUsd: 20_000,
      cappedUsd: 20_000,
      clusters: clusters(20_000, 10),
      ...(overrides.eligibleVolume || {}),
    },
    boost: overrides.boost || {},
    now: NOW,
  });
}

test("founder-locked V3 weights are 50 / 25 / 15 / 10", () => {
  const config = battlePointsV3MarketConfig();
  assert.equal(config.version, BATTLE_POINTS_V3);
  assert.equal(config.mcap.weight, 50);
  assert.equal(config.holders.weight, 25);
  assert.equal(config.volume.weight, 15);
  assert.equal(BATTLE_POINTS_V3_CONFIG.boost.weight, 10);
  assert.equal(config.mcap.weight + config.holders.weight + config.volume.weight + BATTLE_POINTS_V3_CONFIG.boost.weight, 100);
});

test("founder-locked Boost curve metadata is exact and immutable config", () => {
  assert.equal(BATTLE_POINTS_V3_CONFIG.boost.curveVersion, BATTLE_POINTS_V3_BOOST_CURVE);
  assert.deepEqual(BATTLE_POINTS_V3_CONFIG.boost.curveParameters, {
    maxPoints: 10,
    halfSaturationUnits: 100,
    unitUsdMicros: 1_000_000,
  });
  assert.equal(Object.isFrozen(BATTLE_POINTS_V3_CONFIG.boost), true);
  assert.equal(Object.isFrozen(BATTLE_POINTS_V3_CONFIG.boost.curveParameters), true);
});

test("boost_hyperbolic_100_v1 implements 10 * U / (U + 100)", () => {
  assert.equal(calculateBattlePointsV3Boost(0), 0);
  assert.equal(calculateBattlePointsV3Boost(1), 0.099);
  assert.equal(calculateBattlePointsV3Boost(10), 0.9091);
  assert.equal(calculateBattlePointsV3Boost(100), 5);
  assert.equal(calculateBattlePointsV3Boost(900), 9);
  assert.equal(calculateBattlePointsV3Boost(9900), 9.9);
  assert.ok(calculateBattlePointsV3Boost(Number.MAX_SAFE_INTEGER) < 10);
  assert.throws(() => calculateBattlePointsV3Boost(-1), /non-negative integer/);
  assert.throws(() => calculateBattlePointsV3Boost("1.5"), /non-negative integer/);
});

test("V3 market projection does not invent confirmed paid Boost points", () => {
  const result = score({ boost: { units: "100", grossNativeRaw: "1000", poolNativeRaw: "900", protocolNativeRaw: "100" } });
  assert.equal(result.scoringVersion, BATTLE_POINTS_V3);
  assert.equal(result.totalPoints, null);
  assert.equal(result.components.boostPoints, null);
  assert.equal(result.boost.points, null);
  assert.equal(result.boost.curveVersion, BATTLE_POINTS_V3_BOOST_CURVE);
  assert.equal(result.settleable, false);
  assert.equal(result.settlementReason, "boost_points_not_calculated");
});

test("V3 market subtotal is bounded by 90 points", () => {
  const totalVolume = 1_000_000_000;
  const maxed = calculateBattlePointsV3Market({
    baseline: { startMcapUsd: 1_000, startHolders: 10_000 },
    current: {
      marketCapUsd: 1_000_000_000,
      holders: 10_000_000,
      updatedAt: "2026-09-03T11:59:00.000Z",
      healthy: true,
    },
    eligibleVolume: { usd: totalVolume, rawUsd: totalVolume, cappedUsd: totalVolume, clusters: clusters(totalVolume, 10) },
    now: NOW,
  });
  assert.ok(maxed.mcap.points <= 50);
  assert.ok(maxed.holders.points <= 25);
  assert.ok(maxed.volume.points <= 15);
  assert.ok(maxed.marketSubtotal <= 90);
});

test("V3 preserves the existing anti-concentration rule at the 15-point volume weight", () => {
  const whale = score({
    eligibleVolume: {
      usd: 1_000_000,
      rawUsd: 1_000_000,
      cappedUsd: 1_000_000,
      clusters: [{ clusterId: "same-beneficial-owner", countedUsd: 1_000_000 }],
    },
  });
  assert.equal(whale.volume.clusterPointCap, 3);
  assert.ok(whale.volume.points <= 3);
});

test("V3 settlement activation requires both explicit flags after founder curve lock", () => {
  assert.deepEqual(battlePointsV3ActivationStatus({ env: {} }), {
    active: false,
    featureEnabled: false,
    settlementEnabled: false,
    curveConfigured: true,
    reason: "feature_disabled",
  });
  assert.deepEqual(battlePointsV3ActivationStatus({ env: { ARENA_BATTLE_POINTS_V3: "true" } }), {
    active: false,
    featureEnabled: true,
    settlementEnabled: false,
    curveConfigured: true,
    reason: BATTLE_POINTS_V3_SETTLEMENT_DISABLED_REASON,
  });
  assert.deepEqual(battlePointsV3ActivationStatus({ env: { ARENA_BATTLE_POINTS_V3: "true", ARENA_BATTLE_POINTS_V3_SETTLEMENT: "true" } }), {
    active: true,
    featureEnabled: true,
    settlementEnabled: true,
    curveConfigured: true,
    reason: "ok",
  });
});

test("combine requires exact founder curve and healthy market data", () => {
  const market = score();
  assert.throws(
    () => combineBattlePointsV3({ marketScore: market, boostPoints: 5, curveVersion: "test_fixture_only", curveParameters: BATTLE_POINTS_V3_CONFIG.boost.curveParameters }),
    /curve version mismatch/,
  );
  const unhealthy = score({ current: { healthy: false, reasons: ["upstream_unhealthy"] } });
  assert.throws(() => combineBattlePointsV3({ marketScore: unhealthy, boostPoints: 5 }), /market data is unhealthy/);
});

test("V3 total derives Boost points only from confirmed units and remains <= 100", () => {
  const result = calculateBattlePointsV3({
    baseline: { startMcapUsd: 10_000, startHolders: 1_000 },
    current: { marketCapUsd: 12_000, holders: 1_200, updatedAt: "2026-09-03T11:59:00.000Z", healthy: true },
    eligibleVolume: { usd: 20_000, rawUsd: 20_000, cappedUsd: 20_000, clusters: clusters(20_000, 10) },
    boost: { units: 100 },
    now: NOW,
  });
  assert.equal(result.boost.points, 5);
  assert.equal(result.components.boostPoints, 5);
  assert.equal(result.boost.curveVersion, BATTLE_POINTS_V3_BOOST_CURVE);
  assert.equal(result.settleable, true);
  assert.ok(result.totalPoints <= 100);
});
