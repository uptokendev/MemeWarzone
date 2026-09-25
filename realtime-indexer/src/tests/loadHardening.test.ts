import assert from "node:assert/strict";
import test from "node:test";
import { createCandleCoalescer, selectCandleUpdates, type CandleUpdate } from "../candlePublishCoalescer.js";
import { createSignatureMemory } from "../signatureMemory.js";
import { notPublicHiddenSql } from "../publicHidden.js";

const u = (channel: string, event: string, timeframe: string, bucketMs: number, data: unknown): CandleUpdate =>
  ({ channel, event, timeframe, bucketMs, data });

test("a history rebuild of 300 buckets sends only the newest two per timeframe", () => {
  const updates = Array.from({ length: 300 }, (_, i) => u("token:101:A", "market_candle_upsert", "1m", i * 60_000, i));
  const out = selectCandleUpdates(updates).get("token:101:A")!;
  assert.deepEqual(out.map((x) => x.data), [298, 299]);
});

test("the latest update of a bucket wins and every timeframe and event keeps its own slots", () => {
  const out = selectCandleUpdates([
    u("c", "candle_upsert", "1m", 60_000, "old"),
    u("c", "candle_upsert", "1m", 60_000, "new"),
    u("c", "candle_upsert", "5m", 0, "5m"),
    u("c", "market_candle_upsert", "1m", 60_000, "canonical"),
  ]).get("c")!;
  assert.deepEqual(out.map((x) => x.data).sort(), ["5m", "canonical", "new"]);
});

test("one publish call per channel per window", async () => {
  const calls: Array<{ channel: string; n: number }> = [];
  const coalescer = createCandleCoalescer({ flushMs: 60_000, publish: async (channel, messages) => { calls.push({ channel, n: messages.length }); } });
  for (let trade = 0; trade < 20; trade += 1) {
    for (const tf of ["1s", "5s", "1m", "5m", "15m", "30m", "1h", "4h", "1d"]) coalescer.queue(u("token:101:K", "candle_upsert", tf, 0, trade));
  }
  coalescer.queue(u("token:101:Z", "candle_upsert", "1m", 0, 1));
  const sent = await coalescer.flush();
  assert.equal(calls.length, 2);
  assert.equal(sent, 10); // 9 timeframes on K (one bucket each) + 1 on Z, instead of 181 messages
});

test("a publish failure does not lose the other channels", async () => {
  const errors: string[] = [];
  const ok: string[] = [];
  const coalescer = createCandleCoalescer({
    flushMs: 60_000,
    publish: async (channel) => { if (channel === "bad") throw new Error("rate limit"); ok.push(channel); },
    onError: (channel) => errors.push(channel),
  });
  coalescer.queue(u("bad", "e", "1m", 0, 1));
  coalescer.queue(u("good", "e", "1m", 0, 1));
  await coalescer.flush();
  assert.deepEqual(ok, ["good"]);
  assert.deepEqual(errors, ["bad"]);
});

test("signature memory remembers, refreshes and evicts oldest first", () => {
  const memory = createSignatureMemory(100);
  for (let i = 0; i < 100; i += 1) memory.add(`s${i}`);
  memory.add("s0"); // refresh: s0 is now newest
  memory.add("s100");
  assert.equal(memory.has("s0"), true);
  assert.equal(memory.has("s1"), false);
  assert.equal(memory.size(), 100);
});

test("hidden filter matches the API's definition", () => {
  assert.equal(notPublicHiddenSql("c"), "lower(coalesce(c.meta->>'publicHidden', 'false')) not in ('true', '1', 'yes', 'on')");
});
