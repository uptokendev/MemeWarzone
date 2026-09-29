import assert from "node:assert/strict";
import test from "node:test";
import {
  quoteRoutedTotal,
  splitSolFromQuoteSwap,
  swapImpactRefused,
} from "../dbc/dbcQuoteSolSplit.js";

test("proportional SOL split conserves every lamport; remainder to protocol", () => {
  const slices = {
    leagueWeekly: 30n,
    leagueMonthly: 70n,
    recruiter: 125n,
    squad: 25n,
    airdrop: 0n,
    protocol: 750n,
    creatorPool: 80n,
  };
  const routed = quoteRoutedTotal(slices);
  assert.equal(routed, 1000n);
  const sol = 10_000n;
  const out = splitSolFromQuoteSwap(slices, sol);
  assert.equal(out.leagueWeekly + out.leagueMonthly + out.recruiter + out.squad + out.airdrop + out.protocol, sol);
  assert.equal(out.creatorPool, 0n);
  assert.equal(out.recruiter, (sol * 125n) / 1000n);
  assert.equal(out.protocol >= (sol * 750n) / 1000n, true);
});

test("swap refused by the impact cap leaves rows unrouted", () => {
  assert.equal(swapImpactRefused(100n, 100n), false);
  assert.equal(swapImpactRefused(101n, 100n), true);
  assert.equal(swapImpactRefused(0n, 100n), false);
});
