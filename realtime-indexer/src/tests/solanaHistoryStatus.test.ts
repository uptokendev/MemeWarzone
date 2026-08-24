import assert from "node:assert/strict";
import test from "node:test";
import { deriveSolanaHistoryComplete, repairStateFromBackfill } from "../solanaHistoryStatus.js";

test("running lease is never complete", () => {
  const status = deriveSolanaHistoryComplete({
    leaseRunning: true,
    storedHistoryComplete: true,
    storedRepairState: "complete",
  });
  assert.equal(status.historyComplete, false);
  assert.equal(status.repairState, "repairing");
});

test("stored complete repair is durable history", () => {
  const status = deriveSolanaHistoryComplete({
    leaseRunning: false,
    storedHistoryComplete: true,
    storedRepairState: "complete",
  });
  assert.equal(status.historyComplete, true);
  assert.equal(status.repairState, "complete");
});

test("unknown stored state stays incomplete so fallback can run", () => {
  const status = deriveSolanaHistoryComplete({
    leaseRunning: false,
    storedHistoryComplete: null,
    storedRepairState: null,
  });
  assert.equal(status.historyComplete, false);
  assert.equal(status.repairState, "unknown");
});

test("skipped backfill does not mark history complete", () => {
  assert.equal(repairStateFromBackfill({ skipped: true, reachedCreationSlot: true, failed: 0 }), null);
});

test("successful PDA scan with create slot reached is complete", () => {
  const status = repairStateFromBackfill({
    skipped: false,
    incomplete: false,
    failed: 0,
    reachedCreationSlot: true,
  });
  assert.equal(status?.historyComplete, true);
  assert.equal(status?.repairState, "complete");
});
