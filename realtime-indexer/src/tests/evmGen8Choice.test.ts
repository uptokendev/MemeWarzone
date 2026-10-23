import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";

const { planGen8HolderWeekV2, gen8ProposeArgs, GEN8_MAX_BATCH_COINS } = await import("../evm/evmGen8HolderBatch.js");
const { checkGen8LeafFileShape } = await import("../evm/evmGen8HoldThrough.js");
const { holderBatchId, merklePlan, vaultWeek } = await import("../evm/evmCreatorChoice.js");
const { GEN8_APPROVE_HOLDER_BATCH_SELECTOR } = await import("../evm/evmGen8Abi.js");
const { gen8HolderRoom, isContractCode, encodeGen8VaultCall, gen8ContractFilter } = await import("../evm/evmGen8ChoiceChain.js");
const { gen8SpentThisVaultWeek } = await import("../evm/evmGen8ChoicePass.js");
const { withOperatorLock, operatorLockBusy } = await import("../evm/evmGen8OperatorLock.js");
const { gen8ChoiceConfig } = await import("../evm/evmGen8ChoiceWorker.js");

const SUPPLY = 10n ** 27n;
const MIN = SUPPLY / 10_000n;
const P1 = `0x${"11".repeat(32)}`;
const P2 = `0x${"22".repeat(32)}`;
const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const C = "0x00000000000000000000000000000000000000c3";
const VAULT = "0xaf11784a69964A576716a5e4b514341F4437CAd3";
const DIST = "0x3E0A03A723C691f20e4021A575bF7742D605335A";
const NOW = 1_793_000_000;

const check = (index: number, balances: Array<{ owner: string; amount: bigint }>, softExcluded: string[] = []) => ({ index, block: 100 + index, blockTime: NOW - 86_400 * (4 - index), supply: SUPPLY.toString(), holders: balances.length, softExcluded, balances });

function plan(over: Partial<Parameters<typeof planGen8HolderWeekV2>[0]> = {}) {
  return planGen8HolderWeekV2({
    chainId: 56, vault: VAULT, holderDistributor: DIST, weekId: "2026-10-26", nowSec: NOW, holderBatchDelaySec: 86_400, claimWindowDays: 60,
    minPayoutWei: 1n, roomWei: 10n ** 18n, authCapWei: null,
    pools: [
      {
        poolId: P1, token: "0x000000000000000000000000000000000000aaaa", launchedAt: NOW - 30 * 86_400, pot: 1_000n,
        checks: [
          check(0, [{ owner: A, amount: 4n * MIN }, { owner: B, amount: 4n * MIN }, { owner: C, amount: 4n * MIN }]),
          check(1, [{ owner: A, amount: 4n * MIN }, { owner: B, amount: 2n * MIN }]), // C sold out; B dipped
          check(2, [{ owner: A, amount: 4n * MIN }, { owner: B, amount: 4n * MIN }, { owner: C, amount: 9n * MIN }]),
        ],
      },
      { poolId: P2, token: "0x000000000000000000000000000000000000bbbb", launchedAt: NOW - 30 * 86_400, pot: 0n, checks: [check(0, [{ owner: A, amount: MIN }])] },
    ],
    ...over,
  });
}

test("v2 plan: lowest balance through every check, a seller out, zero pots left out, shape and ids", () => {
  const p = plan();
  assert.ok(p.file, p.reason);
  const f = p.file!;
  checkGen8LeafFileShape(f);
  assert.equal(f.batchId, holderBatchId(56, "2026-10-26", "airdrop_holders_gen8"));
  assert.deepEqual(f.pools.map((x) => x.poolId), [P1], "a pool with no pot is not proposed");
  const byAccount = new Map(f.leaves.map((l) => [l.account.toLowerCase(), BigInt(l.amount)]));
  assert.equal(byAccount.get(A), 667n, "4 of 6 parts, remainder to the largest");
  assert.equal(byAccount.get(B), 333n, "the dipper counts with its lowest balance (2 of 6)");
  assert.equal(byAccount.has(C), false, "absent at one check: not paid");
  assert.deepEqual(f.pools[0].checks.map((c) => c.index), [0, 1, 2]);
  assert.equal(f.pools[0].checks[0].holders, 3, "the holder count of a check is before the 0.01% line");
  assert.deepEqual(plan({ pools: [{ poolId: P1, token: "0x000000000000000000000000000000000000aaaa", launchedAt: 0, pot: 9n, checks: [check(0, [{ owner: A, amount: MIN }], [C, B.toUpperCase().replace("0X", "0x")])] }] }).file!.pools[0].checks[0].softExcluded, [B, C], "soft-excluded wallets: lowercase, sorted");
  assert.equal(f.leaves.map((l) => l.account.toLowerCase()).join(), [A, B].sort().join(), "leaves sorted by lowercase address");
  assert.equal(merklePlan(f.leaves.map((l) => ({ account: l.account, amount: BigInt(l.amount) }))).root, f.root);
  assert.deepEqual(gen8ProposeArgs(f), [f.batchId, f.root, BigInt(f.claimDeadline), [P1], [1000n]]);
  assert.equal(f.claimDeadline, NOW + 86_400 + 60 * 86_400);
  assert.deepEqual(p.sends, []);
  assert.equal(p.safe!.executes, false);
  assert.equal(p.safe!.calls[0].data.slice(0, 10), GEN8_APPROVE_HOLDER_BATCH_SELECTOR);
  assert.ok(!p.safe!.calls.some((c) => c.fn === "executeHolderBatch"));
});

test("v2 plan: below 0.01% at a check is out; the minimum payout drops a wallet and its share stays in the pot", () => {
  const p = plan({
    minPayoutWei: 100n,
    pools: [{
      poolId: P1, token: "0x000000000000000000000000000000000000aaaa", launchedAt: 0, pot: 1_000n,
      checks: [check(0, [{ owner: A, amount: 50n * MIN }, { owner: B, amount: MIN - 1n }, { owner: C, amount: MIN }]), check(1, [{ owner: A, amount: 50n * MIN }, { owner: B, amount: 9n * MIN }, { owner: C, amount: MIN }])],
    }],
  });
  const f = p.file!;
  assert.deepEqual(f.leaves.map((l) => l.account.toLowerCase()), [A], "B below 0.01% once; C's 19 wei below the minimum");
  assert.equal(f.pools[0].pot, "1000");
  assert.equal(f.pools[0].amount, f.total, "the pool moves only what reaches a leaf");
  assert.ok(BigInt(f.total) < 1000n);
});

test("v2 plan: room and the distributor authorization fit the pots; nothing when the cap is used up", () => {
  const capped = plan({ authCapWei: 500n });
  assert.equal(capped.file!.pools[0].pot, "500", "fitted to the authorization");
  assert.equal(capped.file!.total, "500");
  assert.equal(plan({ roomWei: 300n, authCapWei: 500n }).file!.pools[0].pot, "300");
  assert.equal(plan({ roomWei: 0n }).file, null);
  assert.equal(plan({ authCapWei: 0n }).file, null);
  assert.equal(plan({ claimWindowDays: 3 }).file, null, "a deadline the vault would refuse is never built");
});

test("v2 plan: at most MAX_BATCH_COINS pools, the largest pots first", () => {
  const pools = Array.from({ length: GEN8_MAX_BATCH_COINS + 5 }, (_, i) => ({
    poolId: ethers.zeroPadValue(ethers.toBeHex(i + 1), 32), token: "0x000000000000000000000000000000000000aaaa", launchedAt: 0, pot: BigInt(1_000 + i),
    checks: [check(0, [{ owner: A, amount: MIN }])],
  }));
  const f = plan({ pools }).file!;
  assert.equal(f.pools.length, GEN8_MAX_BATCH_COINS);
  assert.ok(!f.pools.some((p) => BigInt(p.pot) < 1_005n), "the five smallest roll over");
});

test("vault room: the vault's own week counter, a stale week counts nothing, a failed layout check gives null", () => {
  const caps = { maxBuyPerTx: 0n, maxBuybackPerCoinWeek: 0n, minBuyInterval: 0n, maxImpactBps: 0n, maxHolderBatchPerWeek: 100n };
  const t = 1_793_000_000n;
  assert.equal(gen8HolderRoom({ caps, holderProposedInWeek: 40n, holderWeek: vaultWeek(t) }, t), 60n);
  assert.equal(gen8HolderRoom({ caps, holderProposedInWeek: 40n, holderWeek: vaultWeek(t) - 1n }, t), 100n);
  assert.equal(gen8HolderRoom({ caps, holderProposedInWeek: 140n, holderWeek: vaultWeek(t) }, t), 0n);
  assert.equal(gen8HolderRoom({ caps, holderProposedInWeek: 0n, holderWeek: null }, t), null);
  assert.equal(gen8SpentThisVaultWeek(0n, 5n, t), 0n);
  assert.equal(gen8SpentThisVaultWeek(t - 10n, 5n, t), 5n);
  assert.equal(gen8SpentThisVaultWeek(t - 8n * 86_400n, 5n, t), 0n);
});

test("contract filter: only known contracts are skipped (founder 2026-10-22): gen-8 filters nothing by code", () => {
  assert.deepEqual([...gen8ContractFilter(["0x00000000000000000000000000000000000000aa", "0x00000000000000000000000000000000000000bb"])], []);
  // isContractCode stays for the gen-6/7-style readers.
  assert.equal(isContractCode("0x"), false);
  assert.equal(isContractCode(`0xef0100${"ab".repeat(20)}`), false);
  assert.equal(isContractCode("0x6080604052"), true);
  assert.equal(isContractCode(`0xef0100${"ab".repeat(21)}`), true);
});

test("vault calls encode with bytes32 pool ids", () => {
  assert.equal(encodeGen8VaultCall({ action: "pull", fn: "pull", args: [P1] }).slice(0, 10), ethers.id("pull(bytes32)").slice(0, 10));
  assert.equal(encodeGen8VaultCall({ action: "buyback", fn: "buyback", args: [P1, 5n] }).slice(0, 10), ethers.id("buyback(bytes32,uint256)").slice(0, 10));
  assert.equal(encodeGen8VaultCall({ action: "propose_holder_batch", fn: "proposeHolderBatch", args: [P1, P2, 1n, [P1], [1n]] }).slice(0, 10), ethers.id("proposeHolderBatch(bytes32,bytes32,uint64,bytes32[],uint256[])").slice(0, 10));
});

test("operator lock: one holder at a time per key, FIFO, released on a throw", async () => {
  const operatorAddress = "0x20652bdb1d986220fec30f4733587f279403e773";
  const order: string[] = [];
  const slow = withOperatorLock(operatorAddress, async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 30));
    order.push("a-end");
  });
  const failing = withOperatorLock(operatorAddress.toUpperCase().replace("0X", "0x"), async () => {
    order.push("b");
    throw new Error("boom");
  });
  const third = withOperatorLock(operatorAddress, async () => order.push("c"));
  const other = withOperatorLock("0x0000000000000000000000000000000000000001", async () => order.push("other"));
  await Promise.allSettled([slow, failing, third, other]);
  assert.deepEqual(order.filter((x) => x !== "other"), ["a-start", "a-end", "b", "c"]);
  assert.ok(order.indexOf("other") < order.indexOf("a-end"), "another key is not held up");
  await assert.rejects(failing, /boom/);
  assert.equal(operatorLockBusy(operatorAddress), false);
});

test("config: at most 4 buyback moments a day, pull minimum defaults to the holder minimum, fee cap in gwei", () => {
  const c = gen8ChoiceConfig(56, { EVM_BUYBACK_SEED_SECRET: "s", EVM_BUYBACK_MAX_PER_DAY: "9", EVM_GEN8_CHOICE_MAX_FEE_GWEI_56: "3.5" });
  assert.equal(c.perDay, 4);
  assert.equal(c.pullMinWei, c.minPayoutWei);
  assert.equal(c.minPayoutWei, 1_300_000_000_000_000n);
  assert.equal(c.maxFeePerGasWei, 3_500_000_000n);
  assert.equal(c.holderBatchMaxWei, null);
  const d = gen8ChoiceConfig(4663, { EVM_BUYBACK_MAX_PER_DAY: "2", EVM_GEN8_PULL_MIN_WEI_4663: "7", EVM_GEN8_HOLDER_BATCH_MAX_WEI: "9" });
  assert.equal(d.perDay, 2);
  assert.equal(d.pullMinWei, 7n);
  assert.equal(d.holderBatchMaxWei, 9n);
  assert.equal(d.maxFeePerGasWei, null);
});
