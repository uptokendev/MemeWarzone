import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeWarPoolGeneration,
  presentWarPoolRouting,
} from "./warPoolGenerationRouting.mjs";

test("explicit routing wins regardless of generation", () => {
  assert.deepEqual(
    presentWarPoolRouting({ winnersUsd: 1, protocolUsd: 2, featuredUsd: 3 }, 999, "future_pool_v9"),
    { winnersUsd: 1, protocolUsd: 2, featuredUsd: 3, source: "explicit" },
  );
});

test("WarPool V1 derives only the historical 85/5/10 split", () => {
  assert.deepEqual(presentWarPoolRouting({}, 1000, "war_pool_v1"), {
    winnersUsd: 850,
    protocolUsd: 50,
    featuredUsd: 100,
    source: "war_pool_v1",
  });
});

test("Competition Pool V2 derives 75/5/20 and accepts the compatibility alias", () => {
  for (const generation of ["war_pool_v2", "competition_pool_v2"]) {
    assert.deepEqual(presentWarPoolRouting({}, 1000, generation), {
      winnersUsd: 750,
      protocolUsd: 50,
      featuredUsd: 200,
      source: "war_pool_v2",
    });
  }
});

test("unknown or missing generation never inherits historical economics", () => {
  assert.equal(presentWarPoolRouting({}, 1000, null), null);
  assert.equal(presentWarPoolRouting({}, 1000, "future_pool_v9"), null);
  assert.equal(normalizeWarPoolGeneration("future_pool_v9"), null);
});

test("invalid totals fail closed when routing is not explicit", () => {
  assert.equal(presentWarPoolRouting({}, Number.NaN, "war_pool_v1"), null);
  assert.equal(presentWarPoolRouting({}, -1, "war_pool_v2"), null);
});
