import assert from "node:assert/strict";
import test from "node:test";
import { collectAccountSignatures, sortSignaturesAscending } from "../solanaIndexerCheckpoint.js";

test("campaign PDA pages keep only successful signatures in the create→head window", () => {
  const result = collectAccountSignatures({
    fromSlot: 10,
    head: 40,
    pages: [
      [
        { signature: "c", slot: 30, err: null },
        { signature: "b", slot: 20, err: { InstructionError: [] } },
        { signature: "a", slot: 15, err: null },
        { signature: "old", slot: 5, err: null },
      ],
    ],
  });
  assert.equal(result.reachedHistoricalFrontier, true);
  assert.deepEqual(
    result.items.map((item) => item.signature),
    ["a", "c"],
  );
});

test("campaign PDA pagination stops after a page that reaches the create slot", () => {
  const result = collectAccountSignatures({
    fromSlot: 100,
    head: 300,
    pages: [
      [
        { signature: "tip", slot: 250, err: null },
        { signature: "mid", slot: 180, err: null },
      ],
      [
        { signature: "create", slot: 100, err: null },
        { signature: "before", slot: 90, err: null },
      ],
      [
        { signature: "should-not-scan", slot: 80, err: null },
      ],
    ],
  });
  assert.equal(result.reachedHistoricalFrontier, true);
  assert.deepEqual(
    result.items.map((item) => item.slot),
    [100, 180, 250],
  );
});

test("empty PDA history is a completed frontier, not a live gap", () => {
  const result = collectAccountSignatures({
    fromSlot: 0,
    head: 10,
    pages: [[]],
  });
  assert.equal(result.reachedHistoricalFrontier, true);
  assert.deepEqual(result.items, []);
});

test("oldest-first order is slot then signature", () => {
  const sorted = sortSignaturesAscending([
    { signature: "b", slot: 2 },
    { signature: "a", slot: 2 },
    { signature: "c", slot: 1 },
  ]);
  assert.deepEqual(
    sorted.map((item) => item.signature),
    ["c", "a", "b"],
  );
});
