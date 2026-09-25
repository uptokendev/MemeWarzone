import assert from "node:assert/strict";
import test from "node:test";
import { capVoteImpactHoles, planVoteImpacts, VOTE_IMPACT_MAX_ON_CARD } from "./battleVoteImpacts.mjs";

test("a vote on one side shoots the opponent", () => {
  assert.deepEqual(planVoteImpacts({ left: 3, right: 2 }, { left: 4, right: 2 }), [{ attacker: "left", target: "right", holes: 2 }]);
  assert.deepEqual(planVoteImpacts({ left: 3, right: 2 }, { left: 3, right: 3 }), [{ attacker: "right", target: "left", holes: 2 }]);
});

test("a boost (2 pts) hits twice as hard; both sides can fire in one poll; bursts are capped", () => {
  assert.equal(planVoteImpacts({ left: 0, right: 0 }, { left: 2, right: 0 })[0].holes, 4);
  assert.equal(planVoteImpacts({ left: 0, right: 0 }, { left: 1, right: 1 }).length, 2);
  assert.equal(planVoteImpacts({ left: 0, right: 0 }, { left: 40, right: 0 })[0].holes, 8);
});

test("the first tally is a baseline and nothing fires without a gain", () => {
  assert.deepEqual(planVoteImpacts(null, { left: 9, right: 4 }), []);
  assert.deepEqual(planVoteImpacts({ left: 9, right: 4 }, { left: 9, right: 4 }), []);
  assert.deepEqual(planVoteImpacts({ left: 9, right: 4 }, { left: 8, right: 4 }), []);
  assert.deepEqual(planVoteImpacts({ left: 1, right: 1 }, null), []);
});

test("the card never holds more than the cap", () => {
  const holes = Array.from({ length: VOTE_IMPACT_MAX_ON_CARD + 5 }, (_, i) => ({ id: i }));
  const kept = capVoteImpactHoles(holes);
  assert.equal(kept.length, VOTE_IMPACT_MAX_ON_CARD);
  assert.equal(kept.at(-1).id, VOTE_IMPACT_MAX_ON_CARD + 4);
});
