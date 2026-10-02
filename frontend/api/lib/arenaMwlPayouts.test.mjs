import assert from "node:assert/strict";
import test from "node:test";

import { payoutWalletFor, planMwlPayout } from "./arenaMwlPayouts.js";

const SOL_A = "7ZkEpeo8zcawdj39wpDtB7MbzkbyhNoQyVXLsswazohv";
const SOL_B = "BVTKvynQ8VBJKKA2uau4FC4mNoTmkmb1t4h1y8gMv3Gk";
const PDA = "PCDQmFBrYTV2kfdGtiGWJ2Au9TfaR5ZzBkXdtymV1Bd"; // mwl_vault: off-curve, nobody can sign for it

test("payout wallets: Solana must be an on-curve key, EVM a checksummed non-zero address", () => {
  assert.equal(payoutWalletFor(101, SOL_A), SOL_A);
  assert.equal(payoutWalletFor(101, PDA), null, "a program address can never sign a claim");
  assert.equal(payoutWalletFor(101, "not-a-key"), null);
  assert.equal(payoutWalletFor(56, "0xdcf07eb07e6d6722c246161e7530dc905f9eaa50"), "0xdcf07EB07e6D6722c246161e7530dc905F9eaA50");
  assert.equal(payoutWalletFor(56, "0x0000000000000000000000000000000000000000"), null);
  assert.equal(payoutWalletFor(4663, SOL_A), null, "a Solana wallet cannot claim on Robinhood");
  assert.equal(payoutWalletFor(56, ""), null);
});

const coin = (rank, wallet, points = 3) => ({ tokenAddress: `t${rank}`, finalRank: rank, points, wallet });

test("the whole pot is split exactly over the paid places (min 5 for MWL)", () => {
  const plan = planMwlPayout({ chainId: 56, period: "mwl_monthly", pot: 1_000_000n, standings: [1, 2, 3, 4, 5, 6].map((r) => coin(r, `0x${r}`)) });
  assert.equal(plan.status, "paid");
  assert.equal(plan.winners.length, 5);
  assert.equal(plan.winners.reduce((s, w) => s + w.amount, 0n), 1_000_000n);
  assert.ok(plan.winners[0].amount > plan.winners[1].amount);
});

test("a coin without a valid owner is skipped and the next coin moves up", () => {
  const plan = planMwlPayout({ chainId: 56, period: "mwl_monthly", pot: 1000n, standings: [coin(1, null), coin(2, "0xB"), coin(3, "0xC")] });
  assert.deepEqual(plan.winners.map((w) => [w.rank, w.tokenAddress]), [[1, "t2"], [2, "t3"]]);
});

test("Solana pays only places at or above the minimum; September 2026 shape", () => {
  // Sept: 0.02 SOL MWL share -> monthly 60% = 0.012 SOL; ASK 3 pts, Derpy Dave 1 pt.
  const plan = planMwlPayout({ chainId: 101, period: "mwl_monthly", pot: 12_000_000n, standings: [coin(1, SOL_B, 3), coin(2, SOL_A, 1)], solanaMin: 5_000_000n });
  assert.equal(plan.status, "paid");
  assert.ok(plan.winners.every((w) => w.amount >= 5_000_000n));
  assert.equal(plan.winners.reduce((s, w) => s + w.amount, 0n), 12_000_000n);
  // Too small for even one place: rolled over, nothing written.
  assert.deepEqual(planMwlPayout({ chainId: 101, period: "quarterly", pot: 4_000_000n, standings: [coin(1, SOL_B)], solanaMin: 5_000_000n }), { status: "rolled_over", reason: "below-minimum", winners: [] });
});

test("no pot or no eligible owner rolls over", () => {
  assert.equal(planMwlPayout({ chainId: 56, period: "mwl_monthly", pot: 0n, standings: [coin(1, "0xA")] }).reason, "no-pot");
  assert.equal(planMwlPayout({ chainId: 56, period: "mwl_monthly", pot: 10n, standings: [coin(1, null)] }).reason, "no-eligible-owner");
  assert.equal(planMwlPayout({ chainId: 56, period: "mwl_monthly", pot: 10n, standings: [coin(1, "0xA", 0)] }).reason, "no-eligible-owner", "a coin with zero points did not compete");
});
