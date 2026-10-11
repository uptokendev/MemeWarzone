/**
 * Gen-8 fee attribution and splitter run maths (D1 = A). The key property: a run must be computed from AGGREGATE sums
 * with MwzFeeSplitter.bands(); the sum of per-trade floors misses the lower band by wei and route() reverts OutOfBand.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import {
  aggregateRunAmounts,
  addToSums,
  emptyProfileSums,
  gen8GraduationSlices,
  gen8LeafHash,
  gen8TradeSlices,
  merkleProof,
  merkleRoot,
  perTradeFloorSum,
  splitterBands,
  verifyProof,
  type Gen8Leaf,
  type Gen8Profile,
} from "../evm/evmGen8Fees.js";

/** What MwzFeeSplitter.route checks, line for line (contracts/gen8/MwzFeeSplitter.sol). */
function routeWouldPass(B: bigint, G: bigint, total: bigint, r: { recruiter: bigint; squad: bigint; airdrop: bigint }): string | null {
  const b = splitterBands(B, G);
  const rsa = r.recruiter + r.squad + r.airdrop;
  if (rsa < b.rsaMin || rsa > b.rsaMax || r.squad > b.squadMax) return "OutOfBand";
  if (b.weekly + b.monthly + rsa > total) return "OutOfBand";
  return null;
}

test("per-trade slices: gen-7 / DBC bps of the whole fee, creator 560 bps stays in the hook, everything conserves", () => {
  for (const profile of ["standard_linked", "standard_unlinked", "og_linked"] as Gen8Profile[]) {
    const fee = 1_960_784_313_725_491n;
    const creatorShare = (fee * 560n) / 10_000n;
    const s = gen8TradeSlices({ fee, creatorShare, graduated: false, profile });
    assert.equal(s.leagueWeekly + s.leagueMonthly, (fee * 3750n) / 10_000n);
    assert.equal(s.leagueWeekly, (((fee * 3750n) / 10_000n) * 3000n) / 10_000n);
    assert.equal(s.leagueWeekly + s.leagueMonthly + s.recruiter + s.squad + s.airdrop + s.protocol + s.creatorShare, fee);
    if (profile === "standard_linked") assert.deepEqual([s.recruiter, s.squad, s.airdrop], [(fee * 1250n) / 10_000n, (fee * 250n) / 10_000n, 0n]);
    if (profile === "og_linked") assert.deepEqual([s.recruiter, s.squad, s.airdrop], [(fee * 1500n) / 10_000n, (fee * 250n) / 10_000n, 0n]);
    if (profile === "standard_unlinked") assert.deepEqual([s.recruiter, s.squad, s.airdrop], [0n, 0n, (fee * 1500n) / 10_000n]);
    // protocol keeps 41.9% (39.4% OG) of the fee, as gen-7, within rounding
    const pBps = (s.protocol * 10_000n) / fee;
    assert.ok(pBps === (profile === "og_linked" ? 3940n : 4190n) || pBps === (profile === "og_linked" ? 3939n : 4189n), `${profile} ${pBps}`);
  }
  const post = gen8TradeSlices({ fee: 1000n, creatorShare: 500n, graduated: true, profile: "og_linked" });
  assert.deepEqual([post.recruiter, post.squad, post.airdrop, post.leagueWeekly, post.protocol], [0n, 0n, 0n, 0n, 500n], "after graduation the router half is protocol");
});

test("graduation slices by the creator's profile: 1500/250/0, 1750/250/0, 0/0/1750", () => {
  const g = 106_264_000_000_000_000n;
  assert.deepEqual(Object.values((({ recruiter, squad, airdrop }) => ({ recruiter, squad, airdrop }))(gen8GraduationSlices({ gradFee: g, profile: "standard_linked" }))), [(g * 1500n) / 10_000n, (g * 250n) / 10_000n, 0n]);
  assert.deepEqual(Object.values((({ recruiter, squad, airdrop }) => ({ recruiter, squad, airdrop }))(gen8GraduationSlices({ gradFee: g, profile: "og_linked" }))), [(g * 1750n) / 10_000n, (g * 250n) / 10_000n, 0n]);
  assert.deepEqual(Object.values((({ recruiter, squad, airdrop }) => ({ recruiter, squad, airdrop }))(gen8GraduationSlices({ gradFee: g, profile: "standard_unlinked" }))), [0n, 0n, (g * 1750n) / 10_000n]);
});

test("bands(): the indexer copy of MwzFeeSplitter.bands", () => {
  const b = splitterBands(1_000_000n, 300_001n);
  assert.deepEqual(b, { weekly: 112_500n, monthly: 262_500n, rsaMin: 150_000n + 52_500n, rsaMax: 175_000n + 60_000n, squadMax: 32_500n });
});

test("THE FAILURE: summing per-trade floors misses rsaMin by wei, so route() would revert", () => {
  // 1000 unlinked bonding trades paying 7 wei each: per trade floor(7 * 1500 / 10000) = 1 wei of airdrop.
  const rows = Array.from({ length: 1000 }, () => gen8TradeSlices({ fee: 7n, creatorShare: 0n, graduated: false, profile: "standard_unlinked" }));
  const B = 7_000n;
  const naive = perTradeFloorSum(rows);
  assert.equal(naive.airdrop, 1_000n);
  assert.equal(splitterBands(B, 0n).rsaMin, 1_050n);
  const total = B; // creator share 0 here
  assert.equal(routeWouldPass(B, 0n, total, naive), "OutOfBand", "the per-trade sum is 50 wei under rsaMin");
  // THE FIX: one floor over the aggregate
  const sums = emptyProfileSums();
  for (const _ of rows) addToSums(sums, { kind: "trade", phase: "bonding", profile: "standard_unlinked", fee: 7n });
  const plan = aggregateRunAmounts(sums, splitterBands(B, 0n));
  assert.equal(plan.airdrop, 1_050n);
  assert.equal(routeWouldPass(B, 0n, total, plan), null);
});

test("random runs (realistic fees, graduation fees): per-trade floors fail when the run sits at the band minimum, aggregate always passes", () => {
  let seed = 0x5eedn;
  const rnd = (n: bigint) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return seed % n;
  };
  const profiles: Gen8Profile[] = ["standard_linked", "standard_unlinked", "og_linked"];
  let naiveFailures = 0;
  let edgeRuns = 0;
  for (let run = 0; run < 300; run += 1) {
    const n = 1 + Number(rnd(80n));
    // Half the runs use one profile at exactly the band minimum (1500 bps: linked or unlinked; graduation 1750),
    // the other half mix in OG wallets (1750 bps), which leave slack above rsaMin.
    const edge = run % 2 === 0;
    const edgeProfile: Gen8Profile = rnd(2n) === 0n ? "standard_linked" : "standard_unlinked";
    if (edge) edgeRuns += 1;
    const sums = emptyProfileSums();
    const rows: ReturnType<typeof gen8TradeSlices>[] = [];
    let B = 0n;
    let G = 0n;
    let total = 0n;
    for (let i = 0; i < n; i += 1) {
      const profile = edge ? edgeProfile : profiles[Number(rnd(3n))]!;
      const fee = 1_000n + rnd(10n ** 16n);
      const s = gen8TradeSlices({ fee, creatorShare: (fee * 560n) / 10_000n, graduated: false, profile });
      rows.push(s);
      addToSums(sums, { kind: "trade", phase: "bonding", profile, fee });
      B += fee;
      total += s.routerAmount;
    }
    if (rnd(4n) === 0n) {
      const profile = edge ? edgeProfile : profiles[Number(rnd(3n))]!;
      const g = 10n ** 15n + rnd(10n ** 17n);
      const s = gen8GraduationSlices({ gradFee: g, profile });
      rows.push(s);
      addToSums(sums, { kind: "graduation", phase: "bonding", profile, fee: g });
      G += g;
      total += g;
    }
    if (edge && routeWouldPass(B, G, total, perTradeFloorSum(rows)) !== null) naiveFailures += 1;
    const plan = aggregateRunAmounts(sums, splitterBands(B, G));
    assert.ok(plan.rounding >= 0n && plan.rounding <= 2n, `rounding ${plan.rounding}`);
    assert.equal(plan.recruiter + plan.squad + plan.airdrop, plan.rsa);
    assert.equal(routeWouldPass(B, G, total, plan), null, `run ${run}`);
  }
  assert.ok(naiveFailures > edgeRuns / 2, `the naive sum reverts in most band-minimum runs (${naiveFailures} / ${edgeRuns})`);
});

test("aggregate rule (step-2 fork suite): one floor per pot on summed numerators, squad cap, airdrop takes the remainder", () => {
  // 3 linked trades of 7 wei: recruiter floor(3 x 7 x 1250 / 10000) = 2 (per trade it would be 0 + 0 + 0)
  const sums = emptyProfileSums();
  for (const fee of [7n, 7n, 7n]) addToSums(sums, { kind: "trade", phase: "bonding", profile: "standard_linked", fee });
  const b = splitterBands(21n, 0n);
  const r = aggregateRunAmounts(sums, b);
  assert.equal(r.recruiter, 2n);
  assert.equal(r.squad, 0n);
  assert.equal(r.rsa, 3n, "floor(21 x 1500 / 10000)");
  assert.equal(r.airdrop, 1n, "the rounding remainder goes to airdrop");
  // squad capped at squadMax
  const capped = aggregateRunAmounts(sums, { rsaMin: 0n, rsaMax: 100n, squadMax: 0n });
  assert.equal(capped.squad, 0n);
  // rsa clamped down to rsaMax; airdrop negative -> recruiter gives it back
  const tight = aggregateRunAmounts(sums, { rsaMin: 0n, rsaMax: 1n, squadMax: 10n });
  assert.deepEqual([tight.recruiter, tight.squad, tight.airdrop], [1n, 0n, 0n]);
  // graduation rows use the graduation bps of the profile (OG 1750 / 250)
  const g = emptyProfileSums();
  addToSums(g, { kind: "graduation", phase: "bonding", profile: "og_linked", fee: 10_000n });
  const gr = aggregateRunAmounts(g, splitterBands(0n, 10_000n));
  assert.deepEqual([gr.recruiter, gr.squad, gr.airdrop], [1_750n, 250n, 0n]);
  // post-graduation rows add nothing
  const p = emptyProfileSums();
  addToSums(p, { kind: "trade", phase: "post", profile: "standard_unlinked", fee: 10_000n });
  assert.equal(aggregateRunAmounts(p, splitterBands(0n, 0n)).rsa, 0n);
});

test("accrualRoot: leaves hash deterministically, every proof verifies, any change moves the root", () => {
  const base: Gen8Leaf = {
    chainId: 56, splitter: "0x00000000000000000000000000000000000000aa", runId: 1n, txHash: ethers.id("tx"), logIndex: 3, kind: 0,
    trader: "0x00000000000000000000000000000000000000bb", profile: "standard_linked", fee: 1000n, weekly: 112n, monthly: 263n, recruiter: 125n, squad: 25n, airdrop: 0n, protocol: 419n,
  };
  const leaves = Array.from({ length: 7 }, (_, i) => ({ ...base, logIndex: i, fee: 1000n + BigInt(i) }));
  const hashes = leaves.map(gen8LeafHash);
  const root = merkleRoot(hashes);
  hashes.forEach((h, i) => assert.ok(verifyProof(h, merkleProof(hashes, i), root), `leaf ${i}`));
  const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", "uint256", "bytes32", "uint256", "uint8", "address", "uint8", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
    [56, base.splitter, 1n, base.txHash, 3, 0, base.trader, 0, 1000n, 112n, 263n, 125n, 25n, 0n, 419n],
  ));
  assert.equal(gen8LeafHash(base), ethers.keccak256(inner), "leaf = keccak(keccak(abi.encode(...)))");
  const changed = [...hashes];
  changed[2] = gen8LeafHash({ ...leaves[2]!, recruiter: 126n });
  assert.notEqual(merkleRoot(changed), root);
  assert.equal(merkleRoot([]), ethers.ZeroHash);
});
