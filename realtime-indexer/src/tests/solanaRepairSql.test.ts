import assert from "node:assert/strict";
import test from "node:test";
import { createIndexerSql } from "../solanaRepairSql.js";

test("sql() outside repair calls pool.query exactly once and does not recurse", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rowCount: 1, rows: [{ ok: 1 }] };
    },
  };
  const sql = createIndexerSql(pool, () => false, () => {
    throw new Error("repair query must not run");
  });
  const result = await sql("select 1 as ok", [1]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "select 1 as ok");
  assert.deepEqual(calls[0].values, [1]);
  assert.equal(result.rows[0].ok, 1);
});

test("sql() in repair context uses the timeout client, not pool.query", async () => {
  const poolCalls: string[] = [];
  const repairCalls: string[] = [];
  const pool = {
    query: async (text: string) => {
      poolCalls.push(text);
      return { rowCount: 0, rows: [] };
    },
  };
  const sql = createIndexerSql(pool, () => true, async (text) => {
    repairCalls.push(text);
    return { rowCount: 1, rows: [{ timeout: "15s" }] };
  });
  const result = await sql("select now()", []);
  assert.equal(poolCalls.length, 0);
  assert.equal(repairCalls.length, 1);
  assert.equal(repairCalls[0], "select now()");
  assert.equal(result.rows[0].timeout, "15s");
});
