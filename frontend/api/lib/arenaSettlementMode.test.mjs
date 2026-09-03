import assert from "node:assert/strict";
import test from "node:test";

import {
  ARENA_SETTLEMENT_MODE_V1,
  ARENA_SETTLEMENT_MODE_V2,
  arenaSettlementMode,
} from "./arenaSettlementMode.js";

function withEnv(value, fn) {
  const previous = process.env.ARENA_BATTLE_POINTS_V2;
  if (value == null) delete process.env.ARENA_BATTLE_POINTS_V2;
  else process.env.ARENA_BATTLE_POINTS_V2 = value;
  try {
    return fn();
  } finally {
    if (previous == null) delete process.env.ARENA_BATTLE_POINTS_V2;
    else process.env.ARENA_BATTLE_POINTS_V2 = previous;
  }
}

test("live battles follow the V2 rollout flag", () => {
  withEnv("1", () => assert.equal(arenaSettlementMode({ state: "live" }), ARENA_SETTLEMENT_MODE_V2));
  withEnv("0", () => assert.equal(arenaSettlementMode({ state: "live" }), ARENA_SETTLEMENT_MODE_V1));
});

test("historical V1 finished battles are never relabeled by a later V2 rollout", () => {
  withEnv("1", () => {
    assert.equal(
      arenaSettlementMode({ state: "finished", settlement_version: 1 }),
      ARENA_SETTLEMENT_MODE_V1,
    );
  });
});

test("persisted V2 evidence labels finished battles as Battle Points settlement", () => {
  withEnv("0", () => {
    assert.equal(
      arenaSettlementMode({
        state: "finished",
        settlement_version: 2,
        settlement_scoring_version: "battle_points_v2",
      }),
      ARENA_SETTLEMENT_MODE_V2,
    );
  });
});
