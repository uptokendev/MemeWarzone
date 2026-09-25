import assert from "node:assert/strict";
import test from "node:test";
import { createSolUsdMicrosReader, toUsdMicros } from "./solUsdMicros.js";

const ok = (body) => ({ ok: true, json: async () => body });
const rateLimited = { ok: false, status: 429, json: async () => ({}) };
const sources = [
  { name: "a", url: "a", read: (b) => Number(b?.price) },
  { name: "b", url: "b", read: (b) => Number(b?.price) },
];

test("falls through to the next source when the first is rate-limited", async () => {
  const read = createSolUsdMicrosReader({ sources, fetchImpl: async (url) => (url === "a" ? rateLimited : ok({ price: "121.5" })) });
  assert.equal(await read(), 121_500_000n);
});

test("many concurrent buys share one lookup and the cache", async () => {
  let calls = 0;
  const read = createSolUsdMicrosReader({ sources, fetchImpl: async () => { calls += 1; return ok({ price: 120 }); } });
  const results = await Promise.all(Array.from({ length: 50 }, () => read()));
  assert.ok(results.every((v) => v === 120_000_000n));
  assert.equal(calls, 1);
});

test("every source down: last good price within maxStale, refusal beyond it", async () => {
  let t = 0;
  let up = true;
  const read = createSolUsdMicrosReader({ sources, now: () => t, fetchImpl: async () => (up ? ok({ price: 100 }) : rateLimited) });
  assert.equal(await read(), 100_000_000n);
  up = false;
  t = 90_000; // past the fresh cache
  assert.equal(await read({ maxStaleMs: 300_000 }), 100_000_000n);
  await assert.rejects(() => read({ maxStaleMs: 60_000 }), /every source/);
});

test("broken prices are rejected", () => {
  assert.equal(toUsdMicros("0"), 0n);
  assert.equal(toUsdMicros("NaN"), 0n);
  assert.equal(toUsdMicros(5_000_000), 0n);
  assert.equal(toUsdMicros(142.25), 142_250_000n);
});
