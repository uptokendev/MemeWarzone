import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BATTLE_POINTS_V2, BATTLE_POINTS_V3, BATTLE_POINTS_V3_BOOST_CURVE } from "./arenaBattlePointsConfig.js";
import { calculateCanonicalBattlePoints } from "./arenaBattlePointsCanonical.js";
import { decideBattlePointsV3Settlement } from "./arenaBattleSettleV3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-09-06T18:00:00.000Z");
const read = (name) => fs.readFileSync(path.join(here, name), "utf8");
const migration = fs.readFileSync(path.join(here, "../../../db/migrations/20260906_000006_arena_battle_v3_runtime_activation.sql"), "utf8");

function evidence({ mcap = 12_000, holders = 1_200, eligible = 20_000 } = {}) {
  return {
    baseline: { startMcapUsd: 10_000, startHolders: 1_000, startLiquidityUsd: 2_000, baselineTimestamp: "2026-09-05T18:00:00.000Z" },
    current: { marketCapUsd: mcap, holders, liquidityUsd: 2_500, updatedAt: "2026-09-06T17:59:00.000Z", healthy: true },
    eligibleVolume: {
      usd: eligible, rawUsd: eligible, excludedUsd: 0, cappedUsd: eligible,
      clusters: [
        { clusterId: "a", countedUsd: eligible / 5 }, { clusterId: "b", countedUsd: eligible / 5 },
        { clusterId: "c", countedUsd: eligible / 5 }, { clusterId: "d", countedUsd: eligible / 5 },
        { clusterId: "e", countedUsd: eligible / 5 },
      ],
    },
    now: NOW,
  };
}

function v3(boost = 0, overrides = {}) {
  return calculateCanonicalBattlePoints({ scoringVersion: BATTLE_POINTS_V3, confirmedBoostUnits: boost, ...evidence(overrides) });
}

test("V3 settlement authority is exactly 45/27/18/10 and never exceeds 100", () => {
  const score = v3(1_000_000, { mcap: 50_000, holders: 5_000, eligible: 100_000 });
  assert.equal(score.mcap.maxPoints, 45);
  assert.equal(score.holders.maxPoints, 27);
  assert.equal(score.volume.maxPoints, 18);
  assert.equal(score.boost.maxPoints, 10);
  assert.ok(score.boost.points <= 10);
  assert.ok(score.totalPoints <= 100);
  assert.equal(score.boost.curveVersion, BATTLE_POINTS_V3_BOOST_CURVE);
});

test("confirmed Boost curve and authoritative zero are canonical", () => {
  assert.equal(v3(0).boost.points, 0);
  assert.equal(v3(100).boost.points, 5);
  assert.equal(v3(300).boost.points, 7.5);
  assert.ok(v3(Number.MAX_SAFE_INTEGER).boost.points <= 10);
});

test("V3 winner and draw are determined from canonical total points", () => {
  const left = v3(100, { mcap: 15_000, holders: 1_500, eligible: 30_000 });
  const right = v3(0, { mcap: 11_000, holders: 1_050, eligible: 5_000 });
  const win = decideBattlePointsV3Settlement({ leftToken: "0xleft", rightToken: "0xright", leftScored: left, rightScored: right });
  assert.equal(win.ok, true);
  assert.equal(win.mwlWinnerToken, "0xleft");
  assert.equal(win.mwlDraw, false);

  const equalA = v3(100);
  const equalB = v3(100);
  const draw = decideBattlePointsV3Settlement({ leftToken: "0xleft", rightToken: "0xright", leftScored: equalA, rightScored: equalB });
  assert.equal(draw.ok, true);
  assert.equal(draw.mwlDraw, true);
  assert.equal(draw.mwlWinnerToken, null);
});

test("historical V2 stays 50/30/20 and receives no retroactive Boost", () => {
  const score = calculateCanonicalBattlePoints({ scoringVersion: BATTLE_POINTS_V2, confirmedBoostUnits: 999, ...evidence() });
  assert.equal(score.mcap.maxPoints, 50);
  assert.equal(score.holders.maxPoints, 30);
  assert.equal(score.volume.maxPoints, 20);
  assert.equal(score.boost, null);
  assert.ok(score.totalPoints <= 100);
});

test("missing or unhealthy evidence blocks authoritative settlement", () => {
  const missingBoost = calculateCanonicalBattlePoints({ scoringVersion: BATTLE_POINTS_V3, ...evidence() });
  assert.equal(missingBoost.settleable, false);
  assert.ok(missingBoost.dataHealth.reasons.includes("confirmed_boost_units_unavailable"));

  const invalidMcap = calculateCanonicalBattlePoints({ scoringVersion: BATTLE_POINTS_V3, confirmedBoostUnits: 0, ...evidence(), baseline: { ...evidence().baseline, startMcapUsd: 0 } });
  assert.equal(invalidMcap.settleable, false);
  assert.ok(invalidMcap.dataHealth.reasons.includes("missing_or_invalid_mcap_baseline"));

  const stale = calculateCanonicalBattlePoints({ scoringVersion: BATTLE_POINTS_V3, confirmedBoostUnits: 0, ...evidence(), current: { ...evidence().current, updatedAt: "2026-09-01T00:00:00.000Z" } });
  assert.equal(stale.settleable, false);
  assert.ok(stale.dataHealth.reasons.includes("stale"));

  const noVolume = calculateCanonicalBattlePoints({ scoringVersion: BATTLE_POINTS_V3, confirmedBoostUnits: 0, baseline: evidence().baseline, current: evidence().current, eligibleVolume: null, now: NOW });
  assert.equal(noVolume.settleable, false);
  assert.ok(noVolume.dataHealth.reasons.includes("eligible_volume_evidence_unavailable"));

  const unsupported = calculateCanonicalBattlePoints({ scoringVersion: "battle_points_v99", ...evidence() });
  assert.equal(unsupported.settleable, false);
  assert.deepEqual(unsupported.dataHealth.reasons, ["unsupported_scoring_generation"]);
});

test("runtime calls one canonical calculator and consumes confirmed backend Boost receipts", () => {
  const service = read("arenaBattleSettlementV3Service.js");
  assert.match(service, /calculateCanonicalBattlePoints\s*\(/);
  assert.doesNotMatch(service, /calculateBattlePointsV3Boost|combineBattlePointsV3/);
  assert.match(service, /public\.arena_contest_actions/);
  assert.match(service, /action_type = 'boost'/);
  assert.match(service, /phase = 'regulation'/);
  assert.match(service, /confirmed_at is not null/);
  assert.doesNotMatch(service, /upvote/i);
});

test("immutable generation, fail-closed fallback guard, and tournament separation are structural invariants", () => {
  const runtime = read("arenaBattleSettlementRuntime.js");
  const service = read("arenaBattleSettlementV3Service.js");
  const guard = read("arenaBattleSettlementGuard.js");
  const legacy = read("arenaBattleSettle.js");
  assert.match(runtime, /coalesce\(b\.battle_mode, 'normal'\) = 'normal'/);
  assert.match(runtime, /coalesce\(b\.source, 'queue'\) <> 'tournament'/);
  assert.match(runtime, /contest_scoring_version/);
  assert.match(service, /for update/i);
  assert.match(service, /where id = \$1 and state = 'live'/i);
  assert.match(legacy, /isAuthoritativeSettlementClaimed/);
  assert.match(guard, /claims = new Map/);
  assert.doesNotMatch(service, /ARENA_BATTLE_POINTS_V3|battlePointsV3ActivationStatus/);
  assert.match(migration, /BEFORE INSERT ON public\.arena_battles/i);
  assert.match(migration, /contest_scoring_version := 'battle_points_v3'/i);
  assert.match(migration, /FROM public\.arena_battles/i);
});

test("money winner is not passed into MWL ledger and Vote Tournament never enters Normal V3 scorer", () => {
  const service = read("arenaBattleSettlementV3Service.js");
  const runtime = read("arenaBattleSettlementRuntime.js");
  const recordCall = service.match(/recordFinishedBattle\(\{([\s\S]*?)\}, client\)/)?.[1] || "";
  assert.ok(recordCall.length > 0);
  assert.doesNotMatch(recordCall, /moneyWinnerToken|winner_token/);
  assert.match(recordCall, /mwlWinnerToken/);
  assert.match(runtime, /battle_mode, 'normal'/);
  assert.match(runtime, /source, 'queue'\) <> 'tournament'/);
});

test("Agent 2 API contract exposes frozen score evidence without mixing money and Battle result", () => {
  const api = fs.readFileSync(path.join(here, "../arenaBattleMetrics.js"), "utf8");
  for (const field of ["scoringVersion", "scoringGeneration", "totalPoints", "maxPoints", "rawUsd", "excludedUsd", "eligibleUsd", "confirmedUnits", "curveVersion", "dataHealth", "battleResult", "moneyResult"]) {
    assert.match(api, new RegExp(field));
  }
});

test("global feature flag changes cannot reinterpret an already selected canonical generation", () => {
  const old = process.env.ARENA_BATTLE_POINTS_V3;
  process.env.ARENA_BATTLE_POINTS_V3 = "0";
  const off = v3(23);
  process.env.ARENA_BATTLE_POINTS_V3 = "1";
  const on = v3(23);
  if (old === undefined) delete process.env.ARENA_BATTLE_POINTS_V3;
  else process.env.ARENA_BATTLE_POINTS_V3 = old;
  assert.deepEqual(off, on);
});
