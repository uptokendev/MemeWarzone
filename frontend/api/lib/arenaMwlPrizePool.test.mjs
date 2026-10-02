import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/memewarzone_test";
process.env.PG_DISABLE_SSL = "1";
const { mwlEpochKeys, readMwlPrizePool, toNative } = await import("./arenaMwlPrizePool.js");

test("epoch keys match the claim plan's claimLeague keys", () => {
  const k = mwlEpochKeys("2026-10");
  assert.equal(k.month, "2026-10");
  assert.equal(k.quarter, "2026-Q4");
  assert.equal(k.monthlyEpoch, ethers.id("2026-10"));
  assert.equal(k.quarterlyEpoch, ethers.id("2026-Q4"));
  assert.equal(mwlEpochKeys("2026-03").quarter, "2026-Q1");
  assert.equal(mwlEpochKeys("bad", new Date(Date.UTC(2026, 8, 15))).month, "2026-09");
});

test("EVM reports the contract's 60/40 buckets; Solana one combined vault figure", async () => {
  const evm = await readMwlPrizePool(56, { month: "2026-10", readers: { evm: async () => ({ source: "evm", address: "0xL", monthlyRaw: 6n * 10n ** 17n, quarterlyRaw: 4n * 10n ** 17n, combinedRaw: null }) } });
  assert.equal(evm.split, true);
  assert.equal(evm.monthlyNative, 0.6);
  assert.equal(evm.quarterlyNative, 0.4);
  assert.equal(evm.combinedNative, null);
  const sol = await readMwlPrizePool(101, { month: "2026-10", readers: { solana: async () => ({ source: "solana", address: "PCD", monthlyRaw: null, quarterlyRaw: null, combinedRaw: 1_250_000_000n }) } });
  assert.equal(sol.split, false);
  assert.equal(sol.combinedNative, 1.25);
  assert.equal(sol.monthlyNative, null);
  const none = await readMwlPrizePool(4663, { month: "2026-11", readers: { evm: async () => null } });
  assert.equal(none.available, false);
  assert.equal(toNative(10n ** 18n, 4663), 1);
});
