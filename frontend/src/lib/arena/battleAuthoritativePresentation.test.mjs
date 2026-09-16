import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  authoritativeDraw,
  authoritativeLeaderSide,
  authoritativeScoreAvailable,
  authoritativeScoreRows,
  authoritativeStatusLabel,
  authoritativeWinnerSide,
  normalizeAuthoritativeBattleResult,
} from "./battleAuthoritativePresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(here, relative), "utf8");

function side(tokenId, totalPoints, maxima, { boostPoints = null, confirmedUnits = 0 } = {}) {
  return {
    side: tokenId === "LEFT" ? "left" : "right",
    tokenId,
    totalPoints,
    mcap: { points: 30, maxPoints: maxima[0], start: 100, current: 120, changePct: 20 },
    holders: { points: 10, maxPoints: maxima[1], start: 10, current: 12, changePct: 20 },
    volume: { points: 8, maxPoints: maxima[2], rawUsd: 1200, excludedUsd: 200, eligibleUsd: 1000 },
    boost: { points: boostPoints, maxPoints: maxima[3] ?? 0, confirmedUnits, curveVersion: boostPoints == null ? null : "boost_hyperbolic_100_v1" },
  };
}

function result(generation, overrides = {}) {
  const v3 = generation === 3;
  return normalizeAuthoritativeBattleResult({
    scoringVersion: v3 ? "battle_points_v3" : "battle_points_v2",
    scoringGeneration: generation,
    sides: {
      left: side("LEFT", 72, v3 ? [45, 27, 18, 10] : [50, 30, 20], { boostPoints: v3 ? 3.2 : null, confirmedUnits: v3 ? 47 : 0 }),
      right: side("RIGHT", 68, v3 ? [45, 27, 18, 10] : [50, 30, 20], { boostPoints: v3 ? 1.1 : null, confirmedUnits: v3 ? 12 : 0 }),
    },
    dataHealth: { healthy: true, status: "healthy", reasons: [] },
    battleResult: { state: "live", result: null, draw: false, winnerToken: null },
    moneyResult: { winnerToken: "RIGHT", tieBreak: "volume", tieBreakUsed: true },
    ...overrides,
  });
}

test("V3 renders server-provided 45/27/18/10 categories and confirmed Boost authority", () => {
  const value = result(3);
  assert.deepEqual(authoritativeScoreRows(value.sides.left, value.scoringGeneration).map((row) => [row.label, row.maxPoints]), [
    ["MCAP", 45], ["Holders", 27], ["Eligible Volume", 18], ["Boost", 10],
  ]);
  assert.equal(value.sides.left.boost.confirmedUnits, 47);
  assert.equal(value.sides.left.boost.points, 3.2);
  assert.equal(value.sides.left.boost.curveVersion, "boost_hyperbolic_100_v1");
});

test("historical V2 renders 50/30/20 and never creates a Boost row", () => {
  const value = result(2);
  assert.deepEqual(authoritativeScoreRows(value.sides.left, value.scoringGeneration).map((row) => [row.label, row.maxPoints]), [
    ["MCAP", 50], ["Holders", 30], ["Eligible Volume", 20],
  ]);
  assert.equal(authoritativeScoreRows(value.sides.left, value.scoringGeneration).some((row) => row.key === "boost"), false);
});

test("leader and damage target inputs follow authoritative totalPoints only", () => {
  const value = result(3);
  assert.equal(authoritativeLeaderSide(value), "left");
  value.sides.right.totalPoints = 73;
  assert.equal(authoritativeLeaderSide(value), "right");
  value.sides.left.totalPoints = 73;
  assert.equal(authoritativeLeaderSide(value), "tied");
});

test("Battle winner follows battleResult and never moneyResult", () => {
  const value = result(3, {
    battleResult: { state: "settled", result: "left_win", draw: false, winnerToken: "LEFT" },
    moneyResult: { winnerToken: "RIGHT", tieBreak: "eligible_volume", tieBreakUsed: true },
  });
  // The UI binds the frozen result token to actual Battle participants. This
  // does not depend on optional side token metadata being present.
  value.sides.left.tokenId = null;
  value.sides.right.tokenId = null;
  assert.equal(authoritativeWinnerSide(value, "LEFT", "RIGHT"), "left");
  assert.equal(value.moneyResult.winnerToken, "RIGHT");
});

test("draw has no winner styling", () => {
  const value = result(3, {
    battleResult: { state: "settled", result: "draw", draw: true, winnerToken: null },
  });
  assert.equal(authoritativeDraw(value), true);
  assert.equal(authoritativeWinnerSide(value, "LEFT", "RIGHT"), null);
});

test("unhealthy evidence exposes explicit unavailable state and no leader", () => {
  const value = result(3, { dataHealth: { healthy: false, status: "unhealthy", reasons: ["market_data_stale"] } });
  assert.equal(authoritativeScoreAvailable(value), false);
  assert.equal(authoritativeLeaderSide(value), null);
  assert.equal(authoritativeStatusLabel(value), "Awaiting verified market data");
});

test("client consumes frozen fields without duplicating canonical scoring formulas", () => {
  const client = read("./battleRealtimeApi.ts");
  const component = read("../../components/arena/BattleWallCombatant.tsx");
  const scoreComponent = read("../../components/arena/BattleAuthoritativeScoreBreakdown.tsx");
  const module = read("../../components/arena/BattleWallModule.tsx");
  const helper = read("./battleAuthoritativePresentation.mjs");
  const source = `${client}\n${component}\n${scoreComponent}\n${module}\n${helper}`;
  for (const needle of ["authoritativeResult", "scoringGeneration", "battleResult", "moneyResult", "eligibleUsd", "confirmedUnits", "curveVersion", "totalPoints"]) {
    assert.match(source, new RegExp(needle));
  }
  assert.match(component, /ELIGIBLE VOL/);
  assert.match(scoreComponent, /data-battle-boost-authority="confirmed"/);
  assert.match(module, /authoritativeWinnerSide\(authoritativeResult/);
  assert.doesNotMatch(module, /moneyResult\.winnerToken/);
  assert.doesNotMatch(source, /10\s*\*\s*[A-Za-z_$][\w$]*\s*\/\s*\([^)]*\+\s*100\)/);
  assert.doesNotMatch(`${client}\n${component}\n${scoreComponent}\n${module}`, /marketCapWeight|holderWeight|volumeWeight|boostWeight|calculateBattlePoints/);
});

test("responsive Battle Wall keeps min-width containment and existing combat overlay isolation", () => {
  const component = read("../../components/arena/BattleWallCombatant.tsx");
  const module = read("../../components/arena/BattleWallModule.tsx");
  assert.match(component, /min-w-0/);
  assert.match(component, /max-h-\[22rem\]/);
  assert.match(component, /grid-cols-2/);
  assert.match(module, /grid-cols-1/);
  assert.match(module, /md:grid-cols-\[minmax\(0,1fr\)_auto_minmax\(0,1fr\)\]/);
  assert.match(module, /overflow-hidden/);
  assert.match(module, /<BattleCombatEffects/);
});
