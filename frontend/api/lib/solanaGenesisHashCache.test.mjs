import assert from "node:assert/strict";
import test from "node:test";
import { getGenesisHashCached, resetGenesisHashCache } from "./solanaGenesisHashCache.js";

function conn(rpcEndpoint, impl) {
  const c = { rpcEndpoint, calls: 0, getGenesisHash: async () => { c.calls += 1; return impl(c.calls); } };
  return c;
}

test("genesis hash is fetched once per endpoint", async () => {
  resetGenesisHashCache();
  const a = conn("https://rpc-a", () => "hashA");
  assert.equal(await getGenesisHashCached(a), "hashA");
  assert.equal(await getGenesisHashCached(a), "hashA");
  assert.equal(a.calls, 1);
  const b = conn("https://rpc-b", () => "hashB");
  assert.equal(await getGenesisHashCached(b), "hashB");
});

test("concurrent first calls share one request", async () => {
  resetGenesisHashCache();
  const a = conn("https://rpc-c", () => "hashC");
  const [x, y] = await Promise.all([getGenesisHashCached(a), getGenesisHashCached(a)]);
  assert.equal(x, "hashC");
  assert.equal(y, "hashC");
  assert.equal(a.calls, 1);
});

test("a failed call is not cached", async () => {
  resetGenesisHashCache();
  const a = conn("https://rpc-d", (n) => { if (n === 1) throw new Error("boom"); return "hashD"; });
  await assert.rejects(getGenesisHashCached(a), /boom/);
  assert.equal(await getGenesisHashCached(a), "hashD");
  assert.equal(a.calls, 2);
});

test("a connection without an endpoint is never cached", async () => {
  resetGenesisHashCache();
  const a = conn("", () => "hashE");
  await getGenesisHashCached(a);
  await getGenesisHashCached(a);
  assert.equal(a.calls, 2);
});
