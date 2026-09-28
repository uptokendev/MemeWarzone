// Solana minimum payout (founder, 2026-09-28, option B): every payout path that builds Solana claims
// applies it, and only on Solana. A claim's receipt rent (~0.0013 SOL) must never exceed the prize.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pokerPlacesAboveMinimum, pokerSplitRaw, solanaMinPayoutLamports } from "../shared/pokerPayout.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(repo, p), "utf8");

test("default minimum is 0.005 SOL and can be changed by env", () => {
  assert.equal(solanaMinPayoutLamports({}), 5_000_000n);
  assert.equal(solanaMinPayoutLamports({ SOLANA_MIN_PAYOUT_LAMPORTS: "2500000" }), 2_500_000n);
  assert.equal(solanaMinPayoutLamports({ SOLANA_MIN_PAYOUT_LAMPORTS: "abc" }), 5_000_000n);
});

test("real case: a 0.00001 SOL recruiter amount and a 0.0002 SOL league pot are not paid out on their own", () => {
  assert.ok(10_000n < solanaMinPayoutLamports({}));
  assert.equal(pokerPlacesAboveMinimum(202_569n, 3, solanaMinPayoutLamports({})), 0);
  const places = pokerPlacesAboveMinimum(105_513_760n, 15, 5_000_000n);
  assert.ok(pokerSplitRaw(105_513_760n, places).every((x) => x >= 5_000_000n));
});

test("league settlement applies it on Solana only, and rolls a too-small pot over", () => {
  const src = read("realtime-indexer/src/jobs/finalizeEpochWinners.ts");
  assert.match(src, /chainId === 101 \? pokerPlacesAboveMinimum\(pot, pokerRanks, solanaMinPayoutLamports\(\)\) : pokerRanks/);
  assert.match(src, /below the Solana minimum payout; rolled over/);
});

test("league page shows the same places as the settlement", () => {
  const src = read("frontend/api/league.js");
  assert.match(src, /Number\(chainId\) === 101 \? pokerPlacesAboveMinimum\(pot, pokerPlaces, solanaMinPayoutLamports\(\)\) : pokerPlaces/);
});

test("recruiter batches carry small totals to next week; the airdrop never pays below it", () => {
  assert.match(read("realtime-indexer/src/rewards/publishRecruiterSettlementV2.ts"), /BigInt\(payout\.amountRaw\) < minimum/);
  assert.match(read("frontend/scripts/weekly-airdrop/run-solana-weekly-airdrop.mjs"), /Number\(poolWei \/ solanaMinPayoutLamports\(\)\)/);
});
