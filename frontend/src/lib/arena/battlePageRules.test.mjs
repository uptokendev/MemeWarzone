import test from "node:test";
import assert from "node:assert/strict";
import { battleRules, entrySplitLabel } from "./battlePageRules.mjs";

test("entry split follows the pool generation", () => {
  assert.equal(entrySplitLabel({ poolGeneration: "war_pool_v1" }), "85 prize / 10 league / 5");
  assert.equal(entrySplitLabel({ poolGeneration: "war_pool_v2" }), "75 prize / 20 league / 5");
  assert.equal(entrySplitLabel({}), "75 prize / 20 league / 5");
});

test("rules: vote battles are always ranked; metrics battles name Open War half points", () => {
  assert.match(battleRules({ battleMode: "vote", rankedMode: "open_war" }).join(" "), /winner gets 3 league points/);
  assert.match(battleRules({ battleMode: "normal", rankedMode: "open_war" }).join(" "), /count half/);
  assert.match(battleRules({ battleMode: "normal", rankedMode: "ranked" }).join(" "), /winner gets 3/);
});
