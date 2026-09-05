import assert from "node:assert/strict";
import test from "node:test";

import "./arenaBoostQuote.test.mjs";
import {
  boostSummary,
  exactBattlePointsV3Lock,
  expectedBoostSplit,
  projectBattlePointsV3Row,
  resolveBattlePointsV3Authority,
  resolveBattlePointsV3BoostSaleStatus,
  resolveBattleSide,
  serializeBoostSummary,
  validateConfirmedBoost,
} from "./arenaBoostRuntime.mjs";

test("Boost split keeps integer dust in prize while preserving exact conservation", () => {
  for (const gross of [1n, 2n, 9n, 10n, 11n, 99n, 101n, 10_001n, 999_999n]) {
    const split = expectedBoostSplit(gross);
    assert.equal(split.pool + split.protocol, gross);
    assert.equal(split.protocol, (gross * 1_000n) / 10_000n);
  }
});

test("confirmed Boost rejects client-shaped split drift", () => {
  assert.deepEqual(validateConfirmedBoost({ boostUnits: 3, grossNativeRaw: 101, poolNativeRaw: 91, protocolNativeRaw: 10 }), {
    boostUnits: 3n,
    gross: 101n,
    pool: 91n,
    protocol: 10n,
  });
  assert.throws(
    () => validateConfirmedBoost({ boostUnits: 3, grossNativeRaw: 101, poolNativeRaw: 90, protocolNativeRaw: 11 }),
    /exactly 90% prize \/ 10% protocol/,
  );
  assert.throws(() => validateConfirmedBoost({ boostUnits: 0, grossNativeRaw: 101, poolNativeRaw: 91, protocolNativeRaw: 10 }), /positive/);
});

test("side resolution only accepts an actual combatant token", () => {
  const participants = [
    { tokenId: "0xABC" },
    { tokenAddress: "0xDEF" },
  ];
  assert.equal(resolveBattleSide(participants, "0xabc"), "left");
  assert.equal(resolveBattleSide(participants, "0xDEF"), "right");
  assert.equal(resolveBattleSide(participants, "0xBAD"), null);
});

test("summary aggregates confirmed rows without converting raw native values to Number", () => {
  const rows = [
    { side: "left", boost_units: "2", gross_native_raw: "100000000000000001", pool_native_raw: "90000000000000001", protocol_native_raw: "10000000000000000" },
    { side: "right", boost_units: "1", gross_native_raw: "100", pool_native_raw: "90", protocol_native_raw: "10" },
    { side: "left", boost_units: "4", gross_native_raw: "200", pool_native_raw: "180", protocol_native_raw: "20" },
  ];
  const summary = serializeBoostSummary(boostSummary(rows));
  assert.deepEqual(summary.left, {
    boostUnits: "6",
    grossNativeRaw: "100000000000000201",
    poolNativeRaw: "90000000000000181",
    protocolNativeRaw: "10000000000000020",
  });
  assert.equal(summary.total.boostUnits, "7");
  assert.equal(summary.total.grossNativeRaw, "100000000000000301");
});

const V3_PARAMS = { maxPoints: 10, halfSaturationUnits: 100, unitUsdMicros: 1_000_000 };
const V3_LOCK = {
  scoring_version: "battle_points_v3",
  boost_curve_version: "boost_hyperbolic_100_v1",
  boost_curve_parameters: V3_PARAMS,
};
const V3_BATTLE = {
  state: "live",
  battle_mode: "normal",
  source: "manual",
  competition_generation: "arena_competition_v2",
};
const V3_ENV = { ARENA_BATTLE_POINTS_V3: "true", ARENA_BATTLE_POINTS_V3_SETTLEMENT: "true" };

function projectionRow(side, boostUnits = "100") {
  return {
    battle_id: "battle-v3",
    token_id: side === "left" ? "0xabc" : "0xdef",
    side,
    scoring_version: "battle_points_v3",
    mcap_weight: 45,
    holder_weight: 27,
    volume_weight: 18,
    boost_weight: 10,
    boost_curve_version: "boost_hyperbolic_100_v1",
    boost_curve_parameters: V3_PARAMS,
    boost_units: boostUnits,
    boost_gross_native_raw: "100",
    boost_pool_native_raw: "90",
    boost_protocol_native_raw: "10",
    mcap_points: 20,
    holder_points: 10,
    volume_points: 5,
  };
}

function healthyMetric(side) {
  return {
    side,
    data_healthy: true,
    data_lag_seconds: 30,
    market_data_updated_at: "2026-09-05T08:59:30.000Z",
  };
}

test("V3 Boost authority requires the immutable founder-locked scoring generation", () => {
  assert.equal(exactBattlePointsV3Lock(V3_LOCK), true);
  const projections = ["left", "right"].map((side) => ({ side, ...projectBattlePointsV3Row(projectionRow(side), healthyMetric(side), { now: Date.parse("2026-09-05T09:00:00.000Z") }) }));
  assert.deepEqual(resolveBattlePointsV3BoostSaleStatus({ battle: V3_BATTLE, lock: null, projections, env: V3_ENV }), {
    active: false,
    reason: "historical_scoring_generation",
  });
  assert.equal(resolveBattlePointsV3BoostSaleStatus({ battle: V3_BATTLE, lock: V3_LOCK, projections, env: V3_ENV }).active, true);
});

test("V3 projection reuses the canonical hyperbolic curve and combine path", () => {
  const projected = projectBattlePointsV3Row(projectionRow("left", "100"), healthyMetric("left"), {
    now: Date.parse("2026-09-05T09:00:00.000Z"),
  });
  assert.equal(projected.projectionValid, true);
  assert.equal(projected.scoringReady, true);
  assert.equal(projected.boostPoints, 5);
  assert.equal(projected.totalPoints, 40);
});

test("V3 scoring authority follows feature flags and market data health without disabling confirmed-unit accounting", () => {
  const fresh = ["left", "right"].map((side) => ({ side, ...projectBattlePointsV3Row(projectionRow(side), healthyMetric(side), { now: Date.parse("2026-09-05T09:00:00.000Z") }) }));
  assert.equal(resolveBattlePointsV3Authority({ battle: V3_BATTLE, lock: V3_LOCK, projections: fresh, env: V3_ENV }).active, true);
  assert.equal(resolveBattlePointsV3Authority({ battle: V3_BATTLE, lock: V3_LOCK, projections: fresh, env: {} }).reason, "feature_disabled");

  const staleMetric = { ...healthyMetric("left"), market_data_updated_at: "2026-09-05T08:50:00.000Z" };
  const delayed = [
    { side: "left", ...projectBattlePointsV3Row(projectionRow("left"), staleMetric, { now: Date.parse("2026-09-05T09:00:00.000Z") }) },
    fresh[1],
  ];
  assert.equal(resolveBattlePointsV3BoostSaleStatus({ battle: V3_BATTLE, lock: V3_LOCK, projections: delayed, env: V3_ENV }).active, true);
  assert.deepEqual(
    resolveBattlePointsV3Authority({ battle: V3_BATTLE, lock: V3_LOCK, projections: delayed, env: V3_ENV }).reason,
    "data_delay",
  );
});
