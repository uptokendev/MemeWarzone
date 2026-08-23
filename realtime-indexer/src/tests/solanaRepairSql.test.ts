import { AsyncLocalStorage } from "async_hooks";
import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { createIndexerSql } from "../solanaRepairSql.js";

test("sql() outside repair AsyncLocalStorage calls pool.query exactly once", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      return { rowCount: 1, rows: [{ ok: 1 }] };
    },
  };
  const store = new AsyncLocalStorage<PoolClient>();
  const sql = createIndexerSql(pool as any, store);
  const result = await sql("select 1 as ok", [1]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "select 1 as ok");
  assert.deepEqual(calls[0].values, [1]);
  assert.equal(result.rows[0].ok, 1);
});

test("sql() in repair context uses the dedicated client, not pool.query", async () => {
  const poolCalls: string[] = [];
  const clientCalls: Array<{ text: string; simple?: boolean }> = [];
  const pool = {
    query: async (text: string) => {
      poolCalls.push(text);
      return { rowCount: 0, rows: [] };
    },
  };
  const client = {
    query: async (input: { text: string; values?: unknown[]; simple?: boolean }) => {
      clientCalls.push({ text: input.text, simple: input.simple });
      return { rowCount: 1, rows: [{ timeout: "15s" }] };
    },
  } as unknown as PoolClient;
  const store = new AsyncLocalStorage<PoolClient>();
  const sql = createIndexerSql(pool as any, store);
  const result = await store.run(client, () => sql("select now()", []));
  assert.equal(poolCalls.length, 0);
  assert.equal(clientCalls.length, 1);
  assert.equal(clientCalls[0].text, "select now()");
  assert.equal(clientCalls[0].simple, true);
  assert.equal(result.rows[0].timeout, "15s");
});
