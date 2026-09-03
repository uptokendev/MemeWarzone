import assert from "node:assert/strict";
import test from "node:test";
import "./arenaBattlePointsV3Persistence.test.mjs";
import "./arenaBattlePointsV3Refresh.test.mjs";

import { BATTLE_POINTS_V3, BATTLE_POINTS_V3_CONFIG } from "./arenaBattlePointsConfig.js";
import {
  BATTLE_POINTS_V3_PENDING_REASON,
  battlePointsV3ActivationStatus,
  battlePointsV3MarketConfig,
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

test("founder-locked V3 market weights are 45 / 27 / 18 with 10 reserved for Boost", () => {
  const config = battlePointsV3MarketConfig();
  assert.equal(config.version, BATTLE_POINTS_V3);
  assert.equal(config.mcap.weight, 45);
  assert.equal(config.holders.weight, 27);
  assert.equal(config.volume.weight, 18);
  assert.equal(BATTLE_POINTS_V3_CONFIG.boost.weight, 10);
  assert.equal(config.mcap.weight + config.holders.weight + config.volume.weight + BATTLE_POINTS_V3_CONFIG.boost.weight, 100);
});

test("V3 market scaffold never invents Boost points or a settlement total", () => {
  const result = score({
    boost: {
      units: "12345678901234567890",
      grossNativeRaw: "999999999999999999999999",
      poolNativeRaw: "899999999999999999999999",
      protocolNativeRaw: "100000000000000000000000",
    },
  });
  assert.equal(result.scoringVersion, BATTLE_POINTS_V3);
  assert.equal(result.totalPoints, null);
  assert.equal(result.components.boostPoints, null);
  assert.equal(result.boost.points, null);
  assert.equal(result.boost.curveVersion, "founder_pending");
  assert.equal(result.settleable, false);
  assert.equal(result.settlementReason, BATTLE_POINTS_V3_PENDING_REASON);
  assert.equal(result.boost.units, "12345678901234567890");
  assert.equal(result.boost.grossNativeRaw, "999999999999999999999999");
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
  assert.ok(maxed.mcap.points <= 45);
  assert.ok(maxed.holders.points <= 27);
  assert.ok(maxed.volume.points <= 18);
  assert.ok(maxed.marketSubtotal <= 90);
  assert.equal(maxed.marketSubtotal, maxed.mcap.points + maxed.holders.points + maxed.volume.points);
});

test("V3 preserves the existing anti-concentration rule at the 18-point volume weight", () => {
  const whale = score({
    eligibleVolume: {
      usd: 1_000_000,
      rawUsd: 1_000_000,
      cappedUsd: 1_000_000,
      clusters: [{ clusterId: "same-beneficial-owner", countedUsd: 1_000_000 }],
    },
  });
  assert.equal(whale.volume.clusterPointCap, 3.6);
  assert.ok(whale.volume.points <= 3.6);
  assert.equal(whale.volume.clusterContributions[0].capped, true);
});

test("V3 feature flag cannot activate settlement while founder Boost curve is pending", () => {
  const off = battlePointsV3ActivationStatus({ env: {} });
  assert.deepEqual(off, {
    active: false,
    featureEnabled: false,
    curveConfigured: false,
    reason: "feature_disabled",
  });

  const requested = battlePointsV3ActivationStatus({ env: { ARENA_BATTLE_POINTS_V3: "true" } });
  assert.deepEqual(requested, {
    active: false,
    featureEnabled: true,
    curveConfigured: false,
    reason: BATTLE_POINTS_V3_PENDING_REASON,
  });
});

test("V3 market calculation is deterministic and generation-neutral for normalized inputs", () => {
  const shared = {
    baseline: { startMcapUsd: 20_000, startHolders: 800 },
    current: { marketCapUsd: 24_000, holders: 860, updatedAt: "2026-09-03T11:59:00.000Z", healthy: true },
    eligibleVolume: { usd: 3_000, rawUsd: 3_000, cappedUsd: 3_000, clusters: clusters(3_000) },
    now: NOW,
  };
  const a = calculateBattlePointsV3Market({ ...shared, chainId: 56, venue: "native-a" });
  const b = calculateBattlePointsV3Market({ ...shared, chainId: 101, venue: "native-b" });
  const c = calculateBattlePointsV3Market({ ...shared, chainId: 4663, venue: "stock-c" });
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("combine refuses founder-pending curve and unhealthy market data", () => {
  const market = score();
  assert.throws(
    () => combineBattlePointsV3({ marketScore: market, boostPoints: 5, curveVersion: "founder_pending", curveParameters: {} }),
    new RegExp(BATTLE_POINTS_V3_PENDING_REASON),
  );

  const unhealthy = score({ current: { healthy: false, reasons: ["upstream_unhealthy"] } });
  assert.throws(
    () => combineBattlePointsV3({ marketScore: unhealthy, boostPoints: 5, curveVersion: "test_fixture_only", curveParameters: { fixture: true } }),
    /market data is unhealthy/,
  );
});

test("test-only externally derived Boost points can be combined without defining a production curve", () => {
  const market = score();
  const combined = combineBattlePointsV3({
    marketScore: market,
    boostPoints: 7.5,
    curveVersion: "test_fixture_only",
    curveParameters: { fixtureOnly: true, production: false },
  });
  assert.equal(combined.settleable, true);
  assert.equal(combined.settlementReason, "ok");
  assert.equal(combined.boost.points, 7.5);
  assert.equal(combined.components.boostPoints, 7.5);
  assert.equal(combined.totalPoints, Math.min(100, combined.marketSubtotal + 7.5));
  assert.ok(combined.totalPoints <= 100);
});

test("Boost component can never exceed founder-locked 10-point cap", () => {
  const market = score();
  assert.throws(
    () => combineBattlePointsV3({ marketScore: market, boostPoints: 10.0001, curveVersion: "test_fixture_only", curveParameters: {} }),
    /between 0 and 10/,
  );
  assert.throws(
    () => combineBattlePointsV3({ marketScore: market, boostPoints: -0.1, curveVersion: "test_fixture_only", curveParameters: {} }),
    /between 0 and 10/,
  );
});
