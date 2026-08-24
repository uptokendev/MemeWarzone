import assert from "node:assert/strict";
import test from "node:test";
import { campaignScanChunks } from "../campaignScanChunks.js";

test("history scans oldest-first so the cursor can walk forward", () => {
  assert.deepEqual(campaignScanChunks(100, 250, 100, false), [
    { start: 100, end: 199 },
    { start: 200, end: 250 },
  ]);
});

test("tip scans newest-first so a deadline still indexes the live buy", () => {
  const chunks = campaignScanChunks(100, 250, 100, true);
  assert.equal(chunks[0].end, 250);
  assert.equal(chunks[chunks.length - 1].start, 100);
  assert.deepEqual(chunks, [
    { start: 200, end: 250 },
    { start: 100, end: 199 },
  ]);
});
