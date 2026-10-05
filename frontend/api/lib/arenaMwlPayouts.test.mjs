import assert from "node:assert/strict";
import test from "node:test";

import { payMwlPeriod, payoutWalletFor, planMwlPayout } from "./arenaMwlPayouts.js";

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

test("a hidden test coin is skipped and the next coin moves up (MWL and quarterly)", () => {
  for (const period of ["mwl_monthly", "quarterly"]) {
    const standings = [{ ...coin(1, "0xA"), hidden: true }, coin(2, "0xB"), coin(3, "0xC")];
    const plan = planMwlPayout({ chainId: 56, period, pot: 1000n, standings });
    assert.deepEqual(plan.winners.map((w) => [w.rank, w.tokenAddress]), [[1, "t2"], [2, "t3"]], period);
    assert.equal(plan.winners.reduce((sum, w) => sum + w.amount, 0n), 1000n, "the whole pot goes to the real coins");
  }
  assert.equal(planMwlPayout({ chainId: 56, period: "mwl_monthly", pot: 10n, standings: [{ ...coin(1, "0xA"), hidden: true }] }).reason, "no-eligible-owner");
});

test("payMwlPeriod reads publicHidden per coin and leaves the hidden coin out", async () => {
  const A = "0x1111111111111111111111111111111111111111";
  const B = "0x2222222222222222222222222222222222222222";
  const inserts = [];
  const client = {
    async query(sql, params = []) {
      const text = String(sql);
      if (/^(begin|commit|rollback)$/i.test(text.trim())) return { rows: [] };
      if (text.includes("from public.arena_league_share_ledger")) return { rows: [{ id: 1, amount: "1000" }] };
      if (text.includes("from public.arena_championship_mwl_results")) {
        return { rows: [{ token_address: "tTest", final_rank: 1, points: 9 }, { token_address: "tReal", final_rank: 2, points: 3 }] };
      }
      if (text.includes("publicHidden")) return { rows: params[1] === "tTest" ? [{ "?column?": 1 }] : [] };
      if (text.includes("select creator_address from public.campaigns")) return { rows: [{ creator_address: params[1] === "tTest" ? A : B }] };
      if (text.includes("insert into public.league_epoch_winners")) { inserts.push(params); return { rows: [] }; }
      return { rows: [] };
    },
  };
  const due = { period: "mwl_monthly", chainId: 56, sourceId: "s1", epochStart: new Date("2026-09-01T00:00:00Z"), epochEnd: new Date("2026-10-01T00:00:00Z"), key: "2026-09" };
  const run = await payMwlPeriod(client, due);
  assert.equal(run.status, "paid");
  assert.deepEqual(inserts.map((p) => [p[5], p[6], p[7]]), [[1, "0x2222222222222222222222222222222222222222", "1000"]], "the real coin's owner takes place 1 and the whole pot");
});

test("the MWL live board leaves hidden test coins out, like the payout", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../arenaLeague.js", import.meta.url), "utf8");
  const season = src.slice(src.indexOf("async function activeSeason("), src.indexOf("async function seasonRowForChain("));
  assert.match(season, /from public\.arena_league_entries e/);
  assert.match(season, /and not exists \([\s\S]*from public\.campaigns hc[\s\S]*\$\{publicHiddenWhere\("hc"\)\}/);
  assert.match(season, /\[row\.id, id\]/, "scoped to the season's chain");
});
