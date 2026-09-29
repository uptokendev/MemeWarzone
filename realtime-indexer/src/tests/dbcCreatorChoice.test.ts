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

test("buyback on a bound quote skips with quote-not-sol", async () => {
  const { buybackSkipReason } = await import("../dbc/dbcCreatorPayouts.js");
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  assert.equal(buybackSkipReason("So11111111111111111111111111111111111111112"), null);
  assert.equal(buybackSkipReason(""), null);
  assert.equal(buybackSkipReason("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), "quote-not-sol");
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../dbc/dbcCreatorPayouts.ts"), "utf8");
  assert.match(source, /buybackSkipReason/);
  assert.match(source, /quote-not-sol/);
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
