import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BATTLE_POINTS_V2, BATTLE_POINTS_V3, BATTLE_POINTS_V3_BOOST_CURVE } from "./arenaBattlePointsConfig.js";
import { calculateCanonicalBattlePoints } from "./arenaBattlePointsCanonical.js";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const here = path.dirname(fileURLToPath(import.meta.url));
const canonicalPath = path.join(here, "arenaBattlePointsCanonical.js");
const migrationPath = path.join(here, "../../../db/migrations/20260906_000005_arena_scoring_generation_lock.sql");

function fixture(overrides = {}) {
  return {
    baseline: { startMcapUsd: 10_000, startHolders: 1_000, startLiquidityUsd: 2_000, baselineTimestamp: "2026-09-02T12:00:00.000Z", ...(overrides.baseline || {}) },
    current: { marketCapUsd: 12_000, holders: 1_200, liquidityUsd: 2_500, updatedAt: "2026-09-03T11:59:00.000Z", healthy: true, ...(overrides.current || {}) },
    eligibleVolume: {
      usd: 20_000,
      rawUsd: 20_000,
      excludedUsd: 0,
      cappedUsd: 20_000,
      clusters: [
        { clusterId: "a", countedUsd: 4_000 },
        { clusterId: "b", countedUsd: 4_000 },
        { clusterId: "c", countedUsd: 4_000 },
        { clusterId: "d", countedUsd: 4_000 },
        { clusterId: "e", countedUsd: 4_000 },
      ],
      ...(overrides.eligibleVolume || {}),
    },
    now: NOW,
  };
}

test("historical V2 stays locked to 50/30/20 with no retroactive Boost", () => {
  const score = calculateCanonicalBattlePoints({ scoringVersion: BATTLE_POINTS_V2, ...fixture() });
  assert.equal(score.scoringVersion, BATTLE_POINTS_V2);
  assert.equal(score.scoringGeneration, 2);
  assert.equal(score.mcap.maxPoints, 50);
  assert.equal(score.holders.maxPoints, 30);
  assert.equal(score.volume.maxPoints, 20);
  assert.equal(score.boost, null);
  assert.ok(score.totalPoints <= 100);
  assert.equal(score.dataHealth.healthy, true);
});

test("V3 stays locked to 45/27/18/10 and consumes confirmed Boost units only", () => {
  const score = calculateCanonicalBattlePoints({ scoringVersion: BATTLE_POINTS_V3, confirmedBoostUnits: 100, ...fixture() });
  assert.equal(score.scoringVersion, BATTLE_POINTS_V3);
  assert.equal(score.scoringGeneration, 3);
  assert.equal(score.mcap.maxPoints, 45);
  assert.equal(score.holders.maxPoints, 27);
  assert.equal(score.volume.maxPoints, 18);
  assert.equal(score.boost.maxPoints, 10);
  assert.equal(score.boost.confirmedUnits, 100);
  assert.equal(score.boost.points, 5);
  assert.equal(score.boost.curveVersion, BATTLE_POINTS_V3_BOOST_CURVE);
  assert.ok(score.totalPoints <= 100);
  assert.equal(score.dataHealth.healthy, true);
});

test("zero confirmed Boost is authoritative and scores zero", () => {
  const score = calculateCanonicalBattlePoints({ scoringVersion: BATTLE_POINTS_V3, confirmedBoostUnits: 0, ...fixture() });
  assert.equal(score.boost.confirmedUnits, 0);
  assert.equal(score.boost.points, 0);
  assert.equal(score.dataHealth.healthy, true);
});

test("missing confirmed V3 Boost authority fails closed rather than inventing zero", () => {
  const score = calculateCanonicalBattlePoints({ scoringVersion: BATTLE_POINTS_V3, ...fixture() });
  assert.equal(score.totalPoints, null);
  assert.equal(score.settleable, false);
  assert.equal(score.boost.confirmedUnits, null);
  assert.ok(score.dataHealth.reasons.includes("confirmed_boost_units_unavailable"));
});

test("missing eligible-volume evidence fails closed", () => {
  const input = fixture();
  const score = calculateCanonicalBattlePoints({ scoringVersion: BATTLE_POINTS_V2, baseline: input.baseline, current: input.current, eligibleVolume: null, now: NOW });
  assert.equal(score.totalPoints, null);
  assert.equal(score.settleable, false);
  assert.ok(score.dataHealth.reasons.includes("eligible_volume_evidence_unavailable"));
});

test("invalid baseline and stale market evidence cannot silently decide a winner", () => {
  const invalid = calculateCanonicalBattlePoints({
    scoringVersion: BATTLE_POINTS_V3,
    confirmedBoostUnits: 100,
    ...fixture({ baseline: { startMcapUsd: 0 }, current: { updatedAt: "2026-09-01T00:00:00.000Z" } }),
  });
  assert.equal(invalid.totalPoints, null);
  assert.equal(invalid.settleable, false);
  assert.ok(invalid.dataHealth.reasons.includes("missing_or_invalid_mcap_baseline"));
  assert.ok(invalid.dataHealth.reasons.includes("stale"));
});

test("unsupported or absent generation fails closed", () => {
  for (const version of [undefined, "battle_points_v99"]) {
    const score = calculateCanonicalBattlePoints({ scoringVersion: version, ...fixture() });
    assert.equal(score.totalPoints, null);
    assert.equal(score.settleable, false);
    assert.deepEqual(score.dataHealth.reasons, ["unsupported_scoring_generation"]);
  }
});

test("same normalized inputs are deterministic and calculator has no chain branching", () => {
  const input = { scoringVersion: BATTLE_POINTS_V3, confirmedBoostUnits: 23, ...fixture() };
  assert.deepEqual(calculateCanonicalBattlePoints(input), calculateCanonicalBattlePoints(input));
  const source = fs.readFileSync(canonicalPath, "utf8");
  assert.doesNotMatch(source, /\bBNB\b|\bSolana\b|\bRobinhood\b|chainId|chain_id/);
});

test("pure calculator and volume modules import with DATABASE_URL unset", () => {
  const script = `delete process.env.DATABASE_URL; await import('./arenaBattlePointsCanonical.js'); await import('./arenaBattleVolume.js');`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: here,
    env: { ...process.env, DATABASE_URL: "" },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("migration preserves historical generation and makes scoring locks immutable", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /SET scoring_generation = scoring_version/i);
  assert.match(sql, /boost_hyperbolic_100_v1/);
  assert.match(sql, /BEFORE INSERT ON public\.arena_battle_metrics/i);
  assert.match(sql, /BEFORE UPDATE OF scoring_version, scoring_generation, curve_version/i);
  assert.match(sql, /scoring_generation = scoring_version/i);
  assert.doesNotMatch(sql, /SET scoring_version = 'battle_points_v3'/i);
});
