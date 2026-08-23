import assert from "node:assert/strict";
import test from "node:test";
import { collectAccountSignatures, signatureScanFrontier, sortSignaturesAscending } from "../solanaIndexerCheckpoint.js";

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

test("durable scan is incomplete when the page cap fires before create slot", () => {
  const capped = signatureScanFrontier({
    emptyBatch: false,
    lastSlot: 400,
    fromSlot: 100,
    pagesScanned: 500,
    pageCap: 500,
  });
  assert.equal(capped.reachedCreationSlot, false);
  assert.equal(capped.incomplete, true);
});

test("durable scan is complete when the last page crosses the create slot", () => {
  const done = signatureScanFrontier({
    emptyBatch: false,
    lastSlot: 90,
    fromSlot: 100,
    pagesScanned: 3,
    pageCap: 500,
  });
  assert.equal(done.reachedCreationSlot, true);
  assert.equal(done.incomplete, false);
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
