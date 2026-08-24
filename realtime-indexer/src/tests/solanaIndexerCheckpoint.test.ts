import assert from "node:assert/strict";
import test from "node:test";
import {
  healthStatus,
  nextBackfillCheckpoint,
  recoverFutureCursor,
  sortSignaturesAscending,
} from "../solanaIndexerCheckpoint.js";

test("future cursor is treated as corruption and reset behind head", () => {
  const recovered = recoverFutureCursor({
    storedCursor: 484_930_204,
    head: 440_979_634,
    startSlot: 440_152_698,
    lookback: 50_000,
  });
  assert.equal(recovered.corrupt, true);
  assert.equal(recovered.cursor, 440_152_698);
});

test("healthy cursor is left alone", () => {
  const recovered = recoverFutureCursor({
    storedCursor: 440_978_000,
    head: 440_979_634,
    startSlot: 440_152_698,
    lookback: 50_000,
  });
  assert.equal(recovered.corrupt, false);
  assert.equal(recovered.cursor, 440_978_000);
});

test("page-limited fetch must not advance the durable checkpoint", () => {
  const next = nextBackfillCheckpoint({
    currentCheckpoint: 100,
    reachedHistoricalFrontier: false,
    processedOldestFirst: [
      { signature: "b", slot: 180, ok: true },
      { signature: "c", slot: 190, ok: true },
    ],
  });
  assert.equal(next, 100);
});

test("failed tx stops checkpoint before the gap even if later txs succeeded", () => {
  const next = nextBackfillCheckpoint({
    currentCheckpoint: 100,
    reachedHistoricalFrontier: true,
    processedOldestFirst: [
      { signature: "a", slot: 110, ok: true },
      { signature: "b", slot: 120, ok: false },
      { signature: "c", slot: 130, ok: true },
    ],
  });
  assert.equal(next, 110);
});

test("complete frontier with all ok txs advances to the newest processed slot", () => {
  const next = nextBackfillCheckpoint({
    currentCheckpoint: 100,
    reachedHistoricalFrontier: true,
    processedOldestFirst: sortSignaturesAscending([
      { signature: "c", slot: 130 },
      { signature: "a", slot: 110 },
    ]).map((item) => ({ ...item, ok: true })),
  });
  assert.equal(next, 130);
});

test("health flags a future checkpoint as corrupt", () => {
  assert.equal(
    healthStatus({
      head: 100,
      liveIndexedSlot: 100,
      historicalCheckpoint: 9_999_999,
      lastLiveIngestMs: Date.now(),
      nowMs: Date.now(),
    }),
    "CORRUPT",
  );
});
