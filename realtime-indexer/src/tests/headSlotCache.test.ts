import assert from "node:assert/strict";
import test from "node:test";

import { createHeadSlotCache, headSlotCacheMsFromEnv } from "../headSlotCache.js";

test("head slot cache: repeat calls inside the window share one fetch, then it refreshes", async () => {
  let t = 1_000;
  let calls = 0;
  const cache = createHeadSlotCache(4_000, () => t);
  const fetchSlot = async () => ++calls * 100;
  assert.equal(await cache.get(fetchSlot), 100);
  t += 3_999;
  assert.equal(await cache.get(fetchSlot), 100);
  assert.equal(calls, 1);
  t += 1;
  assert.equal(await cache.get(fetchSlot), 200);
  assert.equal(calls, 2);
});

test("head slot cache: concurrent calls share the in-flight fetch", async () => {
  let calls = 0;
  let release!: (slot: number) => void;
  const cache = createHeadSlotCache(4_000);
  const fetchSlot = () => { calls += 1; return new Promise<number>((resolve) => { release = resolve; }); };
  const a = cache.get(fetchSlot);
  const b = cache.get(fetchSlot);
  release(555);
  assert.deepEqual(await Promise.all([a, b]), [555, 555]);
  assert.equal(calls, 1);
});

test("head slot cache: a failed fetch is not cached and the next call tries again", async () => {
  let calls = 0;
  const cache = createHeadSlotCache(4_000);
  await assert.rejects(cache.get(async () => { calls += 1; throw new Error("rpc down"); }), /rpc down/);
  assert.equal(await cache.get(async () => { calls += 1; return 7; }), 7);
  assert.equal(calls, 2);
});

test("head slot cache: 0 turns it off", async () => {
  let calls = 0;
  const cache = createHeadSlotCache(0);
  await cache.get(async () => ++calls);
  await cache.get(async () => ++calls);
  assert.equal(calls, 2);
});

test("head slot cache env: default 4000, 0 allowed, bad values fall back", () => {
  assert.equal(headSlotCacheMsFromEnv({}), 4_000);
  assert.equal(headSlotCacheMsFromEnv({ SOLANA_HEAD_SLOT_CACHE_MS: "0" }), 0);
  assert.equal(headSlotCacheMsFromEnv({ SOLANA_HEAD_SLOT_CACHE_MS: "1500" }), 1_500);
  assert.equal(headSlotCacheMsFromEnv({ SOLANA_HEAD_SLOT_CACHE_MS: "x" }), 4_000);
  assert.equal(headSlotCacheMsFromEnv({ SOLANA_HEAD_SLOT_CACHE_MS: "-5" }), 0);
});
