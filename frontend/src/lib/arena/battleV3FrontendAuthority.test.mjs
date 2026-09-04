import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { presentArenaMatchRow } from "./arenaMatchRowPresentation.mjs";
import { BATTLE_POINTS_V3_BOOST_CURVE_VERSION, presentBattleGeneration } from "./battleGenerationPresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const battle = {
  id: "battle-v3",
  state: "live",
  participants: [{ symbol: "LEFT" }, { symbol: "RIGHT" }],
};

function metrics(mode, authoritative) {
  return {
    settlementMode: mode,
    scoringVersion: mode,
    dataHealth: { healthy: true },
    leaderSide: "left",
    pointDifference: 3,
    sides: {
      left: { pointsReady: true, points: { total: 72, totalAuthoritative: authoritative } },
      right: { pointsReady: true, points: { total: 69, totalAuthoritative: authoritative } },
    },
  };
}

test("V3 presentation locks the approved curve identifier without calculating it in the browser", () => {
  const generation = presentBattleGeneration({}, { scoringVersion: "battle_points_v3" });
  assert.equal(BATTLE_POINTS_V3_BOOST_CURVE_VERSION, "boost_hyperbolic_100_v1");
  assert.equal(generation.boostCurveVersion, "boost_hyperbolic_100_v1");
  assert.equal(generation.scoreMaxes.boost, 10);

  const realtimeSource = fs.readFileSync(path.join(here, "battleRealtime.ts"), "utf8");
  const metricSource = fs.readFileSync(path.join(here, "../../components/arena/BattleMetricBreakdown.tsx"), "utf8");
  assert.doesNotMatch(realtimeSource, /10\s*\*\s*confirmedBoostUnits|confirmedBoostUnits\s*\/\s*\(/);
  assert.doesNotMatch(metricSource, /10\s*\*\s*confirmedBoostUnits|confirmedBoostUnits\s*\/\s*\(/);
});

test("V3 live total stays unavailable until backend marks it authoritative", () => {
  const model = presentArenaMatchRow(battle, metrics("battle_points_v3", false), { requested: true, loaded: true });
  assert.equal(model.scoreKind, "unavailable");
  assert.equal(model.leftPointsLabel, null);
  assert.equal(model.rightPointsLabel, null);
});

test("V3 renders backend-authoritative final totals", () => {
  const model = presentArenaMatchRow(battle, metrics("battle_points_v3", true), { requested: true, loaded: true });
  assert.equal(model.scoreKind, "battle_points");
  assert.equal(model.leftPointsLabel, "72.0");
  assert.equal(model.rightPointsLabel, "69.0");
});

test("V2 total rendering remains unchanged", () => {
  const model = presentArenaMatchRow(battle, metrics("battle_points_v2", false), { requested: true, loaded: true });
  assert.equal(model.scoreKind, "battle_points");
  assert.equal(model.leftPointsLabel, "72.0");
  assert.equal(model.rightPointsLabel, "69.0");
});
