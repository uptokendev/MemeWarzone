import assert from "node:assert/strict";
import test from "node:test";
import { isDerivedFanoutSuppressed, runWithDerivedFanoutSuppressed } from "../derivedFanout.js";

test("repair suppression is request-scoped and does not leak to a sibling run", async () => {
  assert.equal(isDerivedFanoutSuppressed(), false);
  const order: string[] = [];
  await Promise.all([
    runWithDerivedFanoutSuppressed(async () => {
      order.push("a-start");
      assert.equal(isDerivedFanoutSuppressed(), true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(isDerivedFanoutSuppressed(), true);
      order.push("a-end");
    }),
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("b");
      assert.equal(isDerivedFanoutSuppressed(), false, "live ingest on B must fan out during A's repair");
    })(),
  ]);
  assert.deepEqual(order, ["a-start", "b", "a-end"]);
  assert.equal(isDerivedFanoutSuppressed(), false);
});
