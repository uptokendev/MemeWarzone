import test from "node:test";
import assert from "node:assert/strict";
import { deleteOldWebVitals, ROLLUP_STATE_NAME, ROLLUP_TRAILING_DAYS } from "./rollups.js";

function fakeDb(counts) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: counts.shift() ?? 0 };
    },
  };
}

test("deletes in batches until a short batch", async () => {
  const db = fakeDb([50_000, 50_000, 11_036]);
  const result = await deleteOldWebVitals(db);
  assert.equal(result.deleted, 111_036);
  assert.deepEqual(result.batches, [50_000, 50_000, 11_036]);
  assert.equal(db.calls.length, 3);
  assert.deepEqual(db.calls[0].params, [ROLLUP_STATE_NAME, 14, 50_000]);
  assert.match(db.calls[0].sql, /join public\.analytics_rollup_state s on s\.name = \$1/);
  assert.match(db.calls[0].sql, /e\.name = '\$web_vital'/);
});

test("stops at maxBatches and never goes inside the rollup rebuild window", async () => {
  const db = fakeDb([10, 10, 10, 10]);
  const result = await deleteOldWebVitals(db, { batchSize: 10, maxBatches: 2, retentionDays: 1 });
  assert.equal(db.calls.length, 2);
  assert.equal(result.retentionDays, ROLLUP_TRAILING_DAYS + 1);
});

test("nothing to delete is one query", async () => {
  const db = fakeDb([0]);
  const result = await deleteOldWebVitals(db);
  assert.equal(result.deleted, 0);
  assert.equal(db.calls.length, 1);
});
