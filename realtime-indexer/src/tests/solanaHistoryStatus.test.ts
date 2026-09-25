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

test("head catch-up: a complete campaign re-scans when the chain has newer signatures (KAIJU88, 2026-09-25)", async () => {
  const { headCatchUpPlan } = await import("../solanaHistoryStatus.js");
  // Completed before head tracking existed: one catch-up down to creation, then the head is known.
  assert.deepEqual(headCatchUpPlan({ headSlot: null, creationSlot: 450372683, newestSlot: 450376799 }), { run: true, floorSlot: 450372683, reason: "first-catch-up" });
  // Newer signatures than the last covered slot: scan only down to that slot.
  assert.deepEqual(headCatchUpPlan({ headSlot: 450376799, creationSlot: 450372683, newestSlot: 450380000 }), { run: true, floorSlot: 450376799, reason: "new-signatures" });
  // Nothing new: skip, as before.
  assert.equal(headCatchUpPlan({ headSlot: 450376799, creationSlot: 450372683, newestSlot: 450376799 }).run, false);
  assert.equal(headCatchUpPlan({ headSlot: 450376799, creationSlot: 450372683, newestSlot: null }).run, false);
});

test("the repair pass catches up complete campaigns instead of skipping them forever", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../solanaIndexer.ts", import.meta.url), "utf8");
  const complete = source.slice(source.indexOf("export async function backfillSolanaCampaign"));
  const branch = complete.slice(0, complete.indexOf("const lease = campaignLeases.begin(campaign);"));
  assert.match(branch, /catchUpSolanaCampaignHead\(campaign, stored, signal\)/);
});
