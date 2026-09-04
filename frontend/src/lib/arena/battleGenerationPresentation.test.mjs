import assert from "node:assert/strict";
import test from "node:test";

import {
  BATTLE_POINTS_V2_MAXES,
  BATTLE_POINTS_V3_MAXES,
  presentBattleGeneration,
} from "./battleGenerationPresentation.mjs";

test("historical WarPool V1 economics are shown only from an explicit generation", () => {
  const known = presentBattleGeneration({ poolGeneration: "war_pool_v1" }, {});
  assert.equal(known.pool?.label, "WarPool V1 (Historical)");
  assert.equal(known.pool?.detail, "85% Prize / 10% Post-Grad League / 5% Protocol");

  const unknown = presentBattleGeneration({}, {});
  assert.equal(unknown.pool, null);
});

test("Competition Pool V2 uses the founder-locked 75/20/5 split", () => {
  const known = presentBattleGeneration({ poolGeneration: "war_pool_v2" }, {});
  assert.equal(known.pool?.label, "Competition Pool V2");
  assert.equal(known.pool?.detail, "75% Prize / 20% Post-Grad League / 5% Protocol");
});

test("Battle Points V2 keeps the 50/30/20 component allocation", () => {
  const model = presentBattleGeneration({}, { settlementScoringVersion: "battle_points_v2" });
  assert.equal(model.scoring?.label, "Battle Points V2");
  assert.deepEqual(model.scoreMaxes, BATTLE_POINTS_V2_MAXES);
  assert.equal(model.showScoreBreakdown, true);
  assert.equal(model.boostPending, null);
});

test("Battle Points V3 presents 45/27/18 plus the reserved 10-point Boost component without inventing a curve", () => {
  const model = presentBattleGeneration({}, { scoringVersion: "battle_points_v3" });
  assert.equal(model.scoring?.label, "Battle Points V3");
  assert.equal(model.scoring?.detail, "45 MCAP / 27 Holders / 18 Eligible Volume / 10 Battle Boost");
  assert.deepEqual(model.scoreMaxes, BATTLE_POINTS_V3_MAXES);
  assert.equal(model.showScoreBreakdown, true);
  assert.match(model.boostPending, /pending founder approval/i);
});

test("persisted settlement scoring generation wins over a live scoring version", () => {
  const model = presentBattleGeneration({}, {
    settlementScoringVersion: "mcap_pct_change",
    scoringVersion: "battle_points_v3",
  });
  assert.equal(model.scoring?.label, "Battle scoring V1");
  assert.equal(model.showScoreBreakdown, false);
  assert.equal(model.boostPending, null);
});

test("unknown generations never inherit V1 or V2 economics", () => {
  const model = presentBattleGeneration(
    { poolGeneration: "future_pool_v9" },
    { scoringVersion: "future_score_v9" },
  );
  assert.equal(model.pool, null);
  assert.equal(model.scoring, null);
  assert.equal(model.showScoreBreakdown, false);
  assert.equal(model.scoreMaxes, null);
});
