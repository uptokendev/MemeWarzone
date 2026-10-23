import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";

const H = await import("../evm/evmGen8HoldThrough.js");
const { weekSecret, holderBatchId } = await import("../evm/evmCreatorChoice.js");

const START = new Date("2026-10-26T00:00:00Z");
const END = new Date("2026-11-02T00:00:00Z");
const QUARTER = (7 * 86400_000) / 4;

test("gen-8 checks: one per quarter, per chain, from the chain's week secret", () => {
  const m56 = H.gen8CheckMoments(weekSecret("master", 56, "2026-10-26"), 56, START);
  const m4663 = H.gen8CheckMoments(weekSecret("master", 4663, "2026-10-26"), 4663, START);
  assert.equal(m56.length, 4);
  m56.forEach((at, i) => assert.ok(at.getTime() >= START.getTime() + i * QUARTER && at.getTime() < START.getTime() + (i + 1) * QUARTER));
  assert.notDeepEqual(m56.map(String), m4663.map(String));
  assert.deepEqual(m56.map(String), H.gen8CheckMoments(weekSecret("master", 56, "2026-10-26"), 56, START).map(String));
});

test("due check, check window and the checks a coin must have", () => {
  const m = [10, 20, 30, 40].map((s) => new Date(s * 1000));
  assert.equal(H.gen8DueCheck(m, new Date(9_000)), null);
  assert.equal(H.gen8DueCheck(m, new Date(35_000)), 2);
  assert.deepEqual(H.gen8CheckWindow(m, 1, new Date(50_000)), { from: 20, to: 30 });
  assert.deepEqual(H.gen8CheckWindow(m, 3, new Date(50_000)), { from: 40, to: 50 });
  assert.deepEqual(H.gen8RequiredChecks(m, 0), [0, 1, 2, 3]);
  assert.deepEqual(H.gen8RequiredChecks(m, 25), [2, 3]);
  assert.deepEqual(H.gen8RequiredChecks(m, 41), []);
});

test("eligible at a check: skip, contracts and soft exclusions; soft ones still count in eligible supply", () => {
  const skip = H.gen8HardSkip({ token: "0xT", vault: "0xV", operator: "0xO", creator: "0xC", censusExclusions: ["0xPM"] });
  const balances = new Map<string, bigint>([["0xa", 5n], ["0xC", 9n], ["0xpm", 9n], ["0xk", 3n], ["0xr", 2n], ["0xz", 0n]]);
  const r = H.gen8EligibleAt(balances, skip, new Set(["0xr"]), new Set(["0xk"]));
  assert.deepEqual(r.holders, [{ owner: "0xa", amount: 5n }]);
  assert.equal(r.softExcluded, 2n);
  assert.equal(r.eligibleSupply, 7n);
});

test("shares: lowest balance across checks, 0.01% minimum at every check", () => {
  const supply = 10n ** 27n;
  const min = supply / 10_000n;
  const shares = H.gen8HolderShares(300n, [
    { supply, holders: [{ owner: "a", amount: 2n * min }, { owner: "b", amount: 4n * min }, { owner: "c", amount: min - 1n }] },
    { supply, holders: [{ owner: "a", amount: 2n * min }, { owner: "b", amount: 1n * min }, { owner: "c", amount: 9n * min }] },
  ]);
  assert.deepEqual([...shares.entries()].sort(), [["a", 200n], ["b", 100n]]);
});

test("leaf file shape: sums, parts, batch id", () => {
  const poolId = "0x" + "11".repeat(32);
  const file = {
    kind: "mwz-evm-gen8-holder-batch", version: 2, rule: H.GEN8_HOLDER_RULE, chainId: 56, vault: "0xV", holderDistributor: "0xD",
    weekId: "2026-10-26", batchId: holderBatchId(56, "2026-10-26", "airdrop_holders_gen8"), program: "airdrop_holders_gen8",
    claimDeadline: 1, root: "0x", total: "30",
    pools: [{ poolId, token: "0xT", amount: "30", pot: "40", launchedAt: 0, checks: [{ index: 0, block: 1, blockTime: 1, supply: "1", holders: 2 }] }],
    leaves: [{ account: "0xa", amount: "20", parts: [{ poolId, amount: "20" }] }, { account: "0xb", amount: "10", parts: [{ poolId, amount: "10" }] }],
  } as const;
  H.checkGen8LeafFileShape(file as any);
  assert.throws(() => H.checkGen8LeafFileShape({ ...file, total: "31" } as any));
  assert.throws(() => H.checkGen8LeafFileShape({ ...file, batchId: holderBatchId(56, "2026-10-26", "airdrop_holders_gen7") } as any));
  assert.throws(() => H.checkGen8LeafFileShape({ ...file, pools: [{ ...file.pools[0], pot: "20" }] } as any));
});
