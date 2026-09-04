import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { presentArenaMatchRow } from "./arenaMatchRowPresentation.mjs";
import { BATTLE_POINTS_V3_BOOST_CURVE_VERSION, presentBattleGeneration } from "./battleGenerationPresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const battle = { id: "battle-v3", state: "live", participants: [{ symbol: "LEFT" }, { symbol: "RIGHT" }] };

function metrics(mode, authoritative) {
  return {
    settlementMode: mode, scoringVersion: mode, dataHealth: { healthy: true }, leaderSide: "left", pointDifference: 3,
    sides: {
      left: { pointsReady: true, points: { total: 72, totalAuthoritative: authoritative } },
      right: { pointsReady: true, points: { total: 69, totalAuthoritative: authoritative } },
    },
  };
}

test("V3 presentation locks 45/27/18/10 and approved curve without browser formula", () => {
  const generation = presentBattleGeneration({}, { scoringVersion: "battle_points_v3" });
  assert.equal(BATTLE_POINTS_V3_BOOST_CURVE_VERSION, "boost_hyperbolic_100_v1");
  assert.deepEqual(generation.scoreMaxes, { marketCap: 45, holders: 27, volume: 18, boost: 10 });
  const sources = [
    fs.readFileSync(path.join(here, "battleRealtime.ts"), "utf8"),
    fs.readFileSync(path.join(here, "battleBoostClient.ts"), "utf8"),
    fs.readFileSync(path.join(here, "../../components/arena/BattleBoostPanel.tsx"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(sources, /10\s*\*\s*confirmedBoostUnits|confirmedBoostUnits\s*\/\s*\([^\n]*100/);
});

test("V3 Boost adapter consumes backend projection and normalizes confirmed unit naming", () => {
  const client = fs.readFileSync(path.join(here, "battleBoostClient.ts"), "utf8");
  const panel = fs.readFileSync(path.join(here, "../../components/arena/BattleBoostPanel.tsx"), "utf8");
  const api = fs.readFileSync(path.join(here, "../../../api/arenaBoosts.js"), "utf8");
  assert.match(api, /battlePointsV3/);
  assert.match(api, /boostPoints:/);
  assert.match(api, /boostCurveVersion:/);
  assert.match(api, /totalPoints:/);
  assert.match(client, /confirmedBoostUnits: String\(row\.confirmedBoostUnits \?\? row\.boostUnits/);
  assert.match(panel, /scoringActive === true/);
  assert.match(panel, /\/ 10 Boost pts/);
  assert.match(panel, /Final V3 total awaiting backend authoritative-total status/);
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
  const generation = presentBattleGeneration({}, { scoringVersion: "battle_points_v2" });
  assert.deepEqual(generation.scoreMaxes, { marketCap: 50, holders: 30, volume: 20 });
  const model = presentArenaMatchRow(battle, metrics("battle_points_v2", false), { requested: true, loaded: true });
  assert.equal(model.scoreKind, "battle_points");
  assert.equal(model.leftPointsLabel, "72.0");
  assert.equal(model.rightPointsLabel, "69.0");
});
