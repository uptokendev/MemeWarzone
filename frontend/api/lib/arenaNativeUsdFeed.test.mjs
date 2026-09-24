import assert from "node:assert/strict";
import test from "node:test";

import { NATIVE_ASSET_BY_CHAIN, hasPinnedNativeUsd, nativeUsdMicrosFromPrice, readLiveNativeUsd, withLiveSnapshot } from "./arenaNativeUsdFeed.mjs";

test("every launch chain maps to its native asset and nothing else does", () => {
  assert.deepEqual({ ...NATIVE_ASSET_BY_CHAIN }, { 56: "BNB", 97: "BNB", 4663: "ETH", 46630: "ETH", 101: "SOL" });
});

test("price to micros is exact, ceiling-free, and refuses nonsense", () => {
  assert.equal(nativeUsdMicrosFromPrice("781.75"), 781_750_000n);
  assert.equal(nativeUsdMicrosFromPrice(2679.36), 2_679_360_000n);
  assert.equal(nativeUsdMicrosFromPrice(0.000001), 1n);
  for (const bad of [0, -1, NaN, Infinity, "abc", "", null, 1e8]) assert.throws(() => nativeUsdMicrosFromPrice(bad), `rejects ${String(bad)}`);
  assert.throws(() => nativeUsdMicrosFromPrice(0.0000001), /rounds to zero/);
});

test("live read uses the chain's reader and reports the observation time in seconds", async () => {
  const calls = [];
  const at = 1_790_264_216_500;
  const readers = {
    BNB: async () => { calls.push("BNB"); return { price: 781.75, source: "spot", cached: true, at }; },
    ETH: async () => { calls.push("ETH"); return { price: "2679.36", source: "spot", cached: false, at }; },
    SOL: async () => { calls.push("SOL"); return { price: 116.12, source: "env", cached: false, at }; },
  };
  assert.deepEqual(await readLiveNativeUsd(56, { readers }), { chainId: 56, asset: "BNB", nativeUsdMicros: 781_750_000n, observedAtSeconds: 1_790_264_216, source: "spot", cached: true });
  assert.deepEqual(await readLiveNativeUsd("4663", { readers }), { chainId: 4663, asset: "ETH", nativeUsdMicros: 2_679_360_000n, observedAtSeconds: 1_790_264_216, source: "spot", cached: false });
  assert.deepEqual(await readLiveNativeUsd(101, { readers }), { chainId: 101, asset: "SOL", nativeUsdMicros: 116_120_000n, observedAtSeconds: 1_790_264_216, source: "env", cached: false });
  assert.deepEqual(calls, ["BNB", "ETH", "SOL"]);
});

test("live read fails closed: unknown chain, missing reader, no price, no observation time, reader error", async () => {
  await assert.rejects(() => readLiveNativeUsd(1, { readers: {} }), /no native\/USD feed for chain 1/);
  await assert.rejects(() => readLiveNativeUsd(56, { readers: {} }), /no BNB\/USD reader/);
  await assert.rejects(() => readLiveNativeUsd(56, { readers: { BNB: async () => ({ price: 0, source: "none", cached: false, at: 0 }) } }), /BNB\/USD price is unavailable/);
  await assert.rejects(() => readLiveNativeUsd(4663, { readers: { ETH: async () => ({ price: 2679, source: "spot", cached: false }) } }), /did not report an observation time/);
  await assert.rejects(() => readLiveNativeUsd(101, { readers: { SOL: async () => { throw new Error("boom"); } } }), /boom/);
});

test("a pinned env snapshot is detected by any key, and the live snapshot carries the observation, never now", () => {
  assert.equal(hasPinnedNativeUsd({ A: " " }, ["A"]), false);
  assert.equal(hasPinnedNativeUsd({}, ["A"]), false);
  assert.equal(hasPinnedNativeUsd({ A: "1" }, ["B", "A"]), true);
  const live = { nativeUsdMicros: 5n, observedAtSeconds: 42 };
  assert.deepEqual(withLiveSnapshot({ X: "keep", V: "7" }, { microsKey: "M", updatedAtKey: "U", versionKey: "V" }, live), { X: "keep", V: "7", M: "5", U: "42" });
  assert.equal(withLiveSnapshot({}, { microsKey: "M", updatedAtKey: "U", versionKey: "V", versionFallbackKeys: ["G"] }, live).V, "1");
  assert.equal(withLiveSnapshot({ G: "3" }, { microsKey: "M", updatedAtKey: "U", versionKey: "V", versionFallbackKeys: ["G"] }, live).V, "3");
  assert.equal(withLiveSnapshot({ V: "", G: "3" }, { microsKey: "M", updatedAtKey: "U", versionKey: "V", versionFallbackKeys: ["G"] }, live).V, "3");
});
