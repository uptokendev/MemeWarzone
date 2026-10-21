import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";

const {
  allocateToHolders, buybackMoments, holderLeaves, snapshotMoment, splitShares, weekCommitment, weekOf, weekSecret,
} = await import("../dbc/dbcCreatorChoice.js");
const { dues, holderBalances, sizeBuyback, sqrtImpactBps } = await import("../dbc/dbcCreatorPayouts.js");

test("the week is the airdrop runner's week (Monday 00:00 UTC)", () => {
  assert.equal(weekOf(new Date("2026-09-29T15:00:00Z")).weekId, "2026-09-28");
  assert.equal(weekOf(new Date("2026-10-04T23:59:59Z")).weekId, "2026-09-28");
  assert.equal(weekOf(new Date("2026-10-05T00:00:00Z")).weekId, "2026-10-05");
});

test("moments come from the week secret: same secret, same moments; inside their window", () => {
  const secret = weekSecret("master", "2026-09-28");
  assert.equal(secret, weekSecret("master", "2026-09-28"));
  assert.notEqual(secret, weekSecret("other", "2026-09-28"));
  assert.equal(weekCommitment(secret).length, 64);
  const start = new Date("2026-09-28T00:00:00Z");
  const snap = snapshotMoment(secret, start);
  assert.ok(snap >= start && snap.getTime() < start.getTime() + 7 * 86400_000);
  const day = new Date("2026-09-30T12:00:00Z");
  const a = buybackMoments(secret, "PoolA", day, 4);
  assert.deepEqual(a.map(String), buybackMoments(secret, "PoolA", day, 4).map(String));
  assert.notDeepEqual(a.map(String), buybackMoments(secret, "PoolB", day, 4).map(String));
  for (const m of a) assert.equal(m.toISOString().slice(0, 10), "2026-09-30");
});

test("split: the two parts add up to the pot", () => {
  assert.deepEqual(splitShares(1_000_001n, 60), { creator: 600_000n, holders: 400_001n });
  assert.throws(() => splitShares(1n, 0));
});

test("holders: pro rata, exact to the pot, remainder to the largest holder", () => {
  const shares = allocateToHolders(1_000n, [
    { owner: "A", amount: 1n }, { owner: "B", amount: 1n }, { owner: "C", amount: 1n },
  ]);
  const total = [...shares.values()].reduce((s, v) => s + v, 0n);
  assert.equal(total, 1_000n);
  assert.equal(shares.get("A"), 334n); // largest by name tie-break takes the remainder
});

test("the minimum applies to a wallet's total across coins; below it rolls over, not to others", () => {
  const perCoin = new Map([
    ["Pool1", new Map([["W", 3_000_000n], ["X", 9_000_000n]])],
    ["Pool2", new Map([["W", 3_000_000n], ["Y", 1_000_000n]])],
  ]);
  const { leaves, paidByPool } = holderLeaves(perCoin, 5_000_000n);
  assert.equal(leaves.get("W"), 6_000_000n); // 3M + 3M clears the 5M minimum together
  assert.equal(leaves.get("X"), 9_000_000n);
  assert.equal(leaves.has("Y"), false); // 1M stays unpaid in Pool2
  assert.equal(paidByPool.get("Pool1"), 12_000_000n);
  assert.equal(paidByPool.get("Pool2"), 3_000_000n);
});

test("entitlements from lifetime totals: a rolled-over holder share never goes to the creator", () => {
  const coin = { choice: "split" as const, creatorSharePct: 60 };
  // week 1: pot 100, creator paid 60, holders paid 0 (all below the minimum)
  let d = dues(coin, { total: 100n, paid: { creator: 60n, holders: 0n, buyback: 0n } });
  assert.deepEqual([d.creator, d.holders], [0n, 40n]);
  // week 2: pot grows by 100: creator gets 60 of the new 100 only; holders are owed 40 + 40
  d = dues(coin, { total: 200n, paid: { creator: 60n, holders: 0n, buyback: 0n } });
  assert.deepEqual([d.creator, d.holders], [60n, 80n]);
  assert.equal(dues({ choice: "buyback", creatorSharePct: 0 }, { total: 50n, paid: { creator: 0n, holders: 0n, buyback: 20n } }).buyback, 30n);
});

test("snapshot counts wallets only: program-owned accounts and excluded wallets are dropped", () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const creator = Keypair.generate().publicKey.toBase58();
  const pda = PublicKey.findProgramAddressSync([Buffer.from("vault")], new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"))[0].toBase58();
  const balances = holderBalances(
    [
      { owner: wallet, amount: 5n }, { owner: wallet, amount: 7n },
      { owner: pda, amount: 1_000n }, { owner: creator, amount: 99n }, { owner: wallet, amount: 0n },
    ],
    new Set([creator]),
  );
  assert.deepEqual(balances, [{ owner: wallet, amount: 12n }]);
});

test("buyback size: the largest amount under the impact cap, never above the budget", async () => {
  // impact grows linearly: 1 bps per 1,000,000 lamports
  const quote = async (amountIn: bigint) => ({ amountIn, minOut: amountIn * 10n, impactBps: Number(amountIn) / 1_000_000 });
  const sized = await sizeBuyback(200_000_000n, 10_000_000n, 50, quote);
  assert.ok(sized && sized.impactBps <= 50 && sized.amountIn >= 49_000_000n && sized.amountIn <= 50_000_000n);
  assert.equal((await sizeBuyback(30_000_000n, 10_000_000n, 50, quote))?.amountIn, 30_000_000n);
  assert.equal(await sizeBuyback(5_000_000n, 10_000_000n, 50, quote), null);
  assert.equal(Math.round(sqrtImpactBps(1_000_000n, 1_002_497n)), 50); // (1.002497)^2 - 1 = 0.5%
});

test("DAMM impact from the quote: constant product, exec price is the geometric mean", async () => {
  const { dammImpactBps } = await import("../dbc/dbcCreatorPayouts.js");
  // a buy adding 0.25% to the SOL side of a CP pool moves the price by (1.0025)^2 - 1 = 0.5006%
  const x = 1_000_000_000n; // tokens
  const y = 100_000_000_000n; // SOL raw
  const dy = 250_000_000n;
  const dx = x - (x * y) / (y + dy);
  assert.equal(Math.round(dammImpactBps(Number(y) / Number(x), dy, dx)), 50);
  assert.equal(dammImpactBps(0.1, 1n, 0n), Number.POSITIVE_INFINITY);
});

test("a bound coin's holder share leaves its pot when swapped; the round pays the SOL that swap brought", async () => {
  const { boundHoldersSol } = await import("../dbc/dbcCreatorPayouts.js");
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const coin = { choice: "split" as const, creatorSharePct: 60, quoteMint: usdc };
  // pot 100 USDC raw-units; creator paid 60 (in USDC); holder share 40 swapped for 900 lamports
  const ledger = { total: 100n, paid: { creator: 60n, holders: 300n, buyback: 0n, holdersSwap: 40n }, holdersSolIn: 900n };
  assert.deepEqual(dues(coin, ledger), { creator: 0n, holders: 0n, buyback: 0n });
  assert.equal(boundHoldersSol(ledger), 600n); // 900 SOL in, 300 already in rounds
  // the same ledger read as a SOL coin counts SOL deposits, not swaps
  assert.equal(dues({ choice: "split", creatorSharePct: 60 }, ledger).holders, 40n - 300n);
  assert.equal(boundHoldersSol({ total: 0n, paid: { creator: 0n, holders: 5n, buyback: 0n } }), 0n);
});

test("hold-through starts with the week of 2026-10-26; earlier weeks keep the single snapshot", async () => {
  const { usesHoldThrough } = await import("../dbc/dbcCreatorChoice.js");
  assert.equal(usesHoldThrough("2026-10-19"), false);
  assert.equal(usesHoldThrough("2026-10-26"), true);
  assert.equal(usesHoldThrough("2026-11-02"), true);
});

test("hold-through checks: one secret moment in each quarter of the week, from the week secret", async () => {
  const { holdThroughMoments } = await import("../dbc/dbcCreatorChoice.js");
  const secret = weekSecret("master", "2026-10-26");
  const start = new Date("2026-10-26T00:00:00Z");
  const quarter = (7 * 86400_000) / 4;
  const moments = holdThroughMoments(secret, start);
  assert.equal(moments.length, 4);
  moments.forEach((at, i) => {
    assert.ok(at.getTime() >= start.getTime() + i * quarter && at.getTime() < start.getTime() + (i + 1) * quarter, `check ${i} in quarter ${i}`);
  });
  assert.deepEqual(moments.map(String), holdThroughMoments(secret, start).map(String));
  assert.notDeepEqual(moments.map(String), holdThroughMoments(weekSecret("other", "2026-10-26"), start).map(String));
});

test("the due check is the latest one passed; once the next one is due, a missed check is skipped", async () => {
  const { dueHoldThroughCheck } = await import("../dbc/dbcCreatorChoice.js");
  const m = [10, 20, 30, 40].map((t) => new Date(t));
  assert.equal(dueHoldThroughCheck(m, new Date(9)), null);
  assert.equal(dueHoldThroughCheck(m, new Date(10)), 0);
  assert.equal(dueHoldThroughCheck(m, new Date(25)), 1);
  assert.equal(dueHoldThroughCheck(m, new Date(99)), 3); // down through checks 1 and 2: only 3 is taken
});

test("hold-through balances: lowest balance across checks, 0.01% of supply at every check, absent once = out", async () => {
  const { holdThroughBalances } = await import("../dbc/dbcCreatorChoice.js");
  const supply = 1_000_000_000n * 1_000_000n; // 1B tokens, 6 decimals
  const min = supply / 10_000n; // 100,000 tokens
  const check = (rows: Array<[string, bigint]>) => ({ supply, balances: rows.map(([owner, amount]) => ({ owner, amount })) });
  const out = holdThroughBalances([
    check([["steady", 10n * min], ["dipper", 20n * min], ["small", min - 1n], ["edge", min]]),
    check([["steady", 10n * min], ["dipper", 5n * min], ["small", min - 1n], ["edge", min], ["late", 50n * min]]),
    check([["steady", 10n * min], ["dipper", 20n * min], ["small", min - 1n], ["edge", min], ["late", 50n * min], ["flipper", 90n * min]]),
  ]);
  assert.deepEqual(out, [
    { owner: "dipper", amount: 5n * min },
    { owner: "edge", amount: min },
    { owner: "steady", amount: 10n * min },
  ]);
  // one dip below the minimum at any check is enough to be out for the week
  assert.deepEqual(holdThroughBalances([check([["w", 2n * min]]), check([["w", min - 1n]]), check([["w", 2n * min]])]), []);
  assert.deepEqual(holdThroughBalances([]), []);
});
