import assert from "node:assert/strict";
import test from "node:test";
import { BATTLE_POINTS_CONFIG, BATTLE_POINTS_V1, BATTLE_POINTS_V2 } from "./arenaBattlePointsConfig.js";
import { calculateBattlePoints, interpretHistoricalBattle } from "./arenaBattlePoints.js";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function score(overrides = {}) {
  return calculateBattlePoints({
    baseline: {
      startMcapUsd: 10_000,
      startHolders: 1_000,
      startLiquidityUsd: 4_000,
      baselineTimestamp: "2026-09-01T12:00:00.000Z",
      marketDataUpdatedAt: "2026-09-02T11:59:00.000Z",
      ...(overrides.baseline || {}),
    },
    current: {
      marketCapUsd: 10_000,
      holders: 1_000,
      liquidityUsd: 4_000,
      updatedAt: "2026-09-02T11:59:00.000Z",
      healthy: true,
      ...(overrides.current || {}),
    },
    eligibleVolume: { usd: 0, rawUsd: 0, cappedUsd: 0, ...(overrides.eligibleVolume || {}) },
    now: NOW,
    ...overrides.rest,
  });
}

test("locked weights are 50 / 30 / 20 and version is battle_points_v2", () => {
  assert.equal(BATTLE_POINTS_CONFIG.mcap.weight, 50);
  assert.equal(BATTLE_POINTS_CONFIG.holders.weight, 30);
  assert.equal(BATTLE_POINTS_CONFIG.volume.weight, 20);
  assert.equal(BATTLE_POINTS_CONFIG.version, BATTLE_POINTS_V2);
});

test("MCAP increase awards points below the 50 cap; huge gain saturates toward 50", () => {
  const moderate = score({ current: { marketCapUsd: 12_000, holders: 1_000, updatedAt: "2026-09-02T11:59:00.000Z", healthy: true } });
  assert.ok(moderate.mcap.points > 0);
  assert.ok(moderate.mcap.points < 50);
  assert.equal(moderate.mcap.changePct, 0.2);
  const huge = score({ current: { marketCapUsd: 1_000_000, holders: 1_000, updatedAt: "2026-09-02T11:59:00.000Z", healthy: true } });
  assert.ok(huge.mcap.points > 49);
  assert.ok(huge.mcap.points <= 50);
});

test("MCAP decrease scores 0 mcap points and keeps a negative changePct", () => {
  const down = score({ current: { marketCapUsd: 8_000, holders: 1_000, updatedAt: "2026-09-02T11:59:00.000Z", healthy: true } });
  assert.equal(down.mcap.points, 0);
  assert.ok(down.mcap.changePct < 0);
});

test("holder increase awards points; holder decrease scores 0", () => {
  const up = score({ current: { marketCapUsd: 10_000, holders: 1_350, updatedAt: "2026-09-02T11:59:00.000Z", healthy: true } });
  assert.ok(up.holders.points > 0);
  assert.ok(up.holders.points <= 30);
  const down = score({ current: { marketCapUsd: 10_000, holders: 800, updatedAt: "2026-09-02T11:59:00.000Z", healthy: true } });
  assert.equal(down.holders.points, 0);
  assert.ok(down.holders.changePct < 0);
});

test("tiny holder base 2→10 cannot crush 1000→1350", () => {
  const tiny = calculateBattlePoints({
    baseline: { startMcapUsd: 10_000, startHolders: 2 },
    current: { marketCapUsd: 10_000, holders: 10, updatedAt: "2026-09-02T11:59:00.000Z", healthy: true },
    eligibleVolume: { usd: 0 },
    now: NOW,
  });
  const mature = calculateBattlePoints({
    baseline: { startMcapUsd: 10_000, startHolders: 1_000 },
    current: { marketCapUsd: 10_000, holders: 1_350, updatedAt: "2026-09-02T11:59:00.000Z", healthy: true },
    eligibleVolume: { usd: 0 },
    now: NOW,
  });
  assert.ok(tiny.holders.points < mature.holders.points);
});

test("eligible volume approaches 20 and never exceeds it; zero volume is 0", () => {
  const none = score();
  assert.equal(none.volume.points, 0);
  const high = score({ eligibleVolume: { usd: 100_000, rawUsd: 100_000, cappedUsd: 100_000 } });
  assert.ok(high.volume.points > 19);
  assert.ok(high.volume.points <= 20);
});

test("50/30/20 maxima and total cannot exceed 100", () => {
  const maxed = calculateBattlePoints({
    baseline: { startMcapUsd: 1_000, startHolders: 10_000 },
    current: { marketCapUsd: 1_000_000_000, holders: 10_000_000, updatedAt: "2026-09-02T11:59:00.000Z", healthy: true },
    eligibleVolume: { usd: 1_000_000_000 },
    now: NOW,
  });
  assert.ok(maxed.mcap.points <= 50);
  assert.ok(maxed.holders.points <= 30);
  assert.ok(maxed.volume.points <= 20);
  assert.ok(maxed.totalPoints <= 100);
  assert.equal(maxed.totalPoints, maxed.mcap.points + maxed.holders.points + maxed.volume.points);
});

test("repeated calculation is deterministic", () => {
  const input = {
    baseline: { startMcapUsd: 8_000, startHolders: 400 },
    current: { marketCapUsd: 9_200, holders: 440, updatedAt: "2026-09-02T11:59:00.000Z", healthy: true },
    eligibleVolume: { usd: 1_500, rawUsd: 1_500, cappedUsd: 1_500 },
    now: NOW,
  };
  assert.deepEqual(calculateBattlePoints(input), calculateBattlePoints(input));
});

test("identical normalized inputs produce the same score regardless of extra chain fields", () => {
  const shared = {
    baseline: { startMcapUsd: 20_000, startHolders: 800 },
    current: { marketCapUsd: 24_000, holders: 860, updatedAt: "2026-09-02T11:59:00.000Z", healthy: true },
    eligibleVolume: { usd: 3_000 },
    now: NOW,
  };
  const a = calculateBattlePoints({ ...shared, chainId: 56, venue: "native-a" });
  const b = calculateBattlePoints({ ...shared, chainId: 101, venue: "native-b" });
  const c = calculateBattlePoints({ ...shared, chainId: 4663, venue: "native-c" });
  assert.equal(a.totalPoints, b.totalPoints);
  assert.equal(b.totalPoints, c.totalPoints);
  assert.deepEqual(a.components, c.components);
});

test("stale current still returns numbers and marks dataHealth unhealthy", () => {
  const stale = calculateBattlePoints({
    baseline: { startMcapUsd: 10_000, startHolders: 1_000, baselineTimestamp: "2026-09-01T12:00:00.000Z" },
    current: {
      marketCapUsd: 11_000,
      holders: 1_050,
      updatedAt: "2026-09-02T11:00:00.000Z",
      healthy: false,
      reason: "stale",
      dataLagSeconds: 3600,
    },
    eligibleVolume: { usd: 500 },
    now: NOW,
  });
  assert.ok(stale.totalPoints > 0);
  assert.equal(stale.dataHealth.healthy, false);
  assert.equal(stale.dataHealth.status, "stale");
  assert.ok(stale.dataHealth.reasons.includes("stale"));
});

test("invalid or zero start MCAP yields 0 mcap points and missing health", () => {
  const zero = calculateBattlePoints({
    baseline: { startMcapUsd: 0, startHolders: 100 },
    current: { marketCapUsd: 5_000, holders: 120, updatedAt: "2026-09-02T11:59:00.000Z", healthy: true },
    eligibleVolume: { usd: 0 },
    now: NOW,
  });
  assert.equal(zero.mcap.points, 0);
  assert.equal(zero.mcap.changePct, null);
  assert.equal(zero.dataHealth.healthy, false);
  assert.ok(zero.dataHealth.reasons.includes("invalid_baseline"));
});

test("historical V1 battle remains interpretable as mcap_pct_change", () => {
  const historical = interpretHistoricalBattle({
    settlement_version: 1,
    challenger_start_mcap_usd: 100,
    defender_start_mcap_usd: 80,
    challenger_end_mcap_usd: 110,
    defender_end_mcap_usd: 96,
    challenger_pct_change: 0.1,
    defender_pct_change: 0.2,
  });
  assert.equal(historical.scoringVersion, BATTLE_POINTS_V1);
  assert.equal(historical.scoreBasis, BATTLE_POINTS_V1);
  assert.equal(historical.interpretable, true);
  assert.equal(historical.leftStartMcap, 100);
  assert.equal(historical.rightPct, 0.2);
});

test("scoringVersion is battle_points_v2", () => {
  assert.equal(score().scoringVersion, BATTLE_POINTS_V2);
});
