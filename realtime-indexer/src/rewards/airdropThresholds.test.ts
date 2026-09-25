import assert from "node:assert/strict";
import test from "node:test";
import { LEGACY_BNB_THRESHOLDS, airdropThresholdsForChain, fetchAirdropNativeUsd, usdToNativeRaw } from "./airdropThresholds.js";

test("at $600/BNB the USD rules equal the old BNB rules", () => {
  const t = airdropThresholdsForChain(56, 600);
  assert.equal(t.traderMinVolume, LEGACY_BNB_THRESHOLDS.traderMinVolume); // 0.25 BNB
  assert.equal(t.traderMaxCountedVolume, LEGACY_BNB_THRESHOLDS.traderMaxCountedVolume); // 15 BNB
  assert.equal(t.creatorMinBondingVolume, LEGACY_BNB_THRESHOLDS.creatorMinBondingVolume); // 3 BNB
  assert.equal(t.creatorMaxCountedVolume, LEGACY_BNB_THRESHOLDS.creatorMaxCountedVolume); // 25 BNB
});

test("Solana thresholds are lamports: $150 at $120/SOL is 1.25 SOL, not 250M SOL", () => {
  const t = airdropThresholdsForChain(101, 120);
  assert.equal(t.decimals, 9);
  assert.equal(t.traderMinVolume, 1_250_000_000n);
  assert.equal(t.creatorMinBondingVolume, 15_000_000_000n); // $1800 = 15 SOL
});

test("Robinhood uses 18-decimal ETH", () => {
  assert.equal(airdropThresholdsForChain(4663, 3000).traderMinVolume, 50_000_000_000_000_000n); // 0.05 ETH
});

test("conversion refuses a missing price", () => {
  assert.throws(() => usdToNativeRaw(150, 0, 18));
});

test("price source: pinned env wins, and an unknown chain refuses instead of guessing", async () => {
  process.env.AIRDROP_NATIVE_USD_101 = "123.5";
  assert.equal(await fetchAirdropNativeUsd(101), 123.5);
  delete process.env.AIRDROP_NATIVE_USD_101;
  await assert.rejects(() => fetchAirdropNativeUsd(999));
  const down = (async () => new Response("", { status: 503 })) as typeof fetch;
  await assert.rejects(() => fetchAirdropNativeUsd(56, down), /refuses to guess/);
});
