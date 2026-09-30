import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { ethers } from "ethers";
import {
  DAY_MS,
  allocateToHolders,
  buildLeafFile,
  buybackBudget,
  checkLeafFile,
  curveRoom,
  dayMoments,
  dueMomentKey,
  fitPotsToRoom,
  holderBatchId,
  impactBps,
  linearCurvePriceAfter,
  merkleLeaf,
  merklePlan,
  previousWeek,
  sizeWithinImpact,
  snapshotMoment,
  vaultWeek,
  verifyProof,
  weekCommitment,
  weekOf,
  weekSecret,
  weeklyRunDue,
  type VaultLimits,
} from "./evmCreatorChoice.js";
import { foldTransfers } from "./evmCreatorChoiceChain.js";
import { assertOperatorKeyAllowed, choiceConfig, enabledChoiceChains, operatorWallet, vaultAddress } from "./evmCreatorChoiceConfig.js";

const C = "0x00000000000000000000000000000000000000c1";
const LIMITS: VaultLimits = { paused: false, buyPerTx: 650n, buybackPerCampaignWeek: 6_500n, buyInterval: 21_600n, impactBps: 50n, holderBatchPerWeek: 32_000n };

test("weeks are Monday 00:00 UTC, the Monday run starts five minutes in", () => {
  const w = weekOf(new Date("2026-09-30T12:00:00Z"));
  assert.equal(w.weekId, "2026-09-28");
  assert.equal(weekOf(new Date("2026-10-04T23:59:59Z")).weekId, "2026-09-28");
  assert.equal(weekOf(new Date("2026-10-05T00:00:00Z")).weekId, "2026-10-05");
  assert.equal(previousWeek(new Date("2026-10-05T00:10:00Z")).weekId, "2026-09-28");
  assert.equal(weeklyRunDue(new Date("2026-10-05T00:04:59Z")), false);
  assert.equal(weeklyRunDue(new Date("2026-10-05T00:05:00Z")), true);
  assert.equal(weeklyRunDue(new Date("2026-10-04T23:00:00Z")), true);
});

test("seed: one secret per chain and week, its sha256 is the commitment, and every moment is recomputable from it", () => {
  const s56 = weekSecret("master", 56, "2026-09-28");
  const s4663 = weekSecret("master", 4663, "2026-09-28");
  assert.notEqual(s56, s4663);
  assert.equal(s56, crypto.createHmac("sha256", "master").update("evm-week:56:2026-09-28").digest("hex"));
  assert.equal(weekCommitment(s56), crypto.createHash("sha256").update(s56).digest("hex"));
  assert.throws(() => weekSecret("", 56, "2026-09-28"), /EVM_BUYBACK_SEED_SECRET/);
  const start = weekOf(new Date("2026-09-30T00:00:00Z")).start;
  const snap = snapshotMoment(s56, 56, start);
  assert.ok(snap.getTime() >= start.getTime() && snap.getTime() < start.getTime() + 7 * DAY_MS);
  // Spec C6: moment i = HMAC(secret, chain|campaign|day|i) mod day, sorted.
  const day = new Date("2026-09-30T00:00:00Z");
  const moments = dayMoments(s56, 56, C.toUpperCase().replace("0X", "0x"), day, 4);
  const expected = [0, 1, 2, 3]
    .map((i) => Number(crypto.createHmac("sha256", s56).update(`56|${C}|2026-09-30|${i}`).digest().readBigUInt64BE(0) % BigInt(DAY_MS)))
    .map((o) => new Date(day.getTime() + o))
    .sort((a, b) => a.getTime() - b.getTime());
  assert.deepEqual(moments, expected);
  assert.notDeepEqual(dayMoments(s56, 56, C, day, 4, "convert"), moments);
});

test("dueMomentKey: only the latest passed moment, once; missed moments are not caught up; never a future one", () => {
  const now = new Date("2026-09-30T23:59:59Z");
  const k = dueMomentKey({ masterSecret: "m", chainId: 56, campaign: C, now, perDay: 4, used: new Set() });
  assert.equal(k, "2026-09-30:3");
  assert.equal(dueMomentKey({ masterSecret: "m", chainId: 56, campaign: C, now, perDay: 4, used: new Set([k!]) }), null);
  // Before the first moment of the day only yesterday's can be due.
  const secret = weekSecret("m", 56, weekOf(new Date("2026-09-30T00:00:00Z")).weekId);
  const first = dayMoments(secret, 56, C, new Date("2026-09-30T00:00:00Z"), 4)[0];
  const early = dueMomentKey({ masterSecret: "m", chainId: 56, campaign: C, now: new Date(first.getTime() - 1), perDay: 4, used: new Set() });
  assert.match(String(early), /^2026-09-29:/);
});

test("caps: per buy, per coin per week, and the curve's 95% line", () => {
  assert.equal(buybackBudget({ balance: 10_000n, limits: LIMITS, spentThisWeek: 0n }), 650n);
  assert.equal(buybackBudget({ balance: 100n, limits: LIMITS, spentThisWeek: 0n }), 100n);
  assert.equal(buybackBudget({ balance: 10_000n, limits: LIMITS, spentThisWeek: 6_200n }), 300n);
  assert.equal(buybackBudget({ balance: 10_000n, limits: LIMITS, spentThisWeek: 7_000n }), 0n);
  assert.equal(curveRoom(900n, 1_000n), 50n);
  assert.equal(curveRoom(960n, 1_000n), 0n);
  assert.equal(vaultWeek(604_800n * 3n + 5n), 3n);
});

test("impact: linear-curve price after a buy and the binary search stay within the limit", async () => {
  // price = 1e9 + k*sold; a buy of t tokens costs t*(p0 + k*t/2): after = p0 + k*t.
  const p0 = 1_000_000_000n;
  const t = 10n ** 18n;
  const k = 1_000n;
  const cost = (t * p0) / 10n ** 18n + (k * t * t) / (2n * 10n ** 36n);
  const after = linearCurvePriceAfter(p0, cost, t);
  assert.ok(after >= p0 + k - 1n && after <= p0 + k + 1n);
  assert.equal(impactBps(1_000n, 1_005n), 50);
  const est = async (amount: bigint) => Number(amount) / 10; // 10 wei = 1 bps
  assert.equal(await sizeWithinImpact(10_000n, 1n, 40, est), 400n);
  assert.equal(await sizeWithinImpact(300n, 1n, 40, est), 300n);
  assert.equal(await sizeWithinImpact(10_000n, 500n, 40, est), null);
  assert.equal(await sizeWithinImpact(10n, 100n, 40, est), null);
});

test("holder pots are scaled into the weekly room; allocation is exact with the remainder to the largest holder", () => {
  const pots = new Map([["a", 600n], ["b", 400n]]);
  assert.deepEqual(fitPotsToRoom(pots, 2_000n), pots);
  assert.deepEqual([...fitPotsToRoom(pots, 500n)], [["a", 300n], ["b", 200n]]);
  assert.equal(fitPotsToRoom(pots, 0n).size, 0);
  const shares = allocateToHolders(100n, [{ owner: "0xa", amount: 1n }, { owner: "0xb", amount: 2n }]);
  assert.equal(shares.get("0xa")! + shares.get("0xb")!, 100n);
  assert.equal(shares.get("0xb"), 67n);
});

function sampleFile(minPayout = 10n) {
  const perCoin = new Map([
    [C, new Map([["0x00000000000000000000000000000000000000a1", 700n], ["0x00000000000000000000000000000000000000a2", 5n]])],
    ["0x00000000000000000000000000000000000000c2", new Map([["0x00000000000000000000000000000000000000a1", 100n], ["0x00000000000000000000000000000000000000a3", 200n]])],
  ]);
  return buildLeafFile({
    chainId: 56,
    vault: "0x00000000000000000000000000000000000000aa",
    holderDistributor: "0x00000000000000000000000000000000000000bb",
    weekId: "2026-09-21",
    claimDeadline: 1_800_000_000,
    weekCommitment: "ab",
    perCoin,
    minPayout,
    snapshots: [],
  })!;
}

test("leaf file: one leaf per wallet across coins, wallets below the minimum roll over, root and proofs verify", () => {
  const f = sampleFile();
  assert.equal(f.leaves.length, 2); // a2 (5 wei) is below the minimum: not paid, stays in its coin
  assert.equal(f.total, "1000");
  assert.deepEqual(f.campaigns.map((c) => c.amount), ["700", "300"]);
  assert.equal(f.batchId, holderBatchId(56, "2026-09-21"));
  // The id the deploy script and the weekly runner compute.
  assert.equal(f.batchId, ethers.keccak256(ethers.toUtf8Bytes("mwz-weekly-airdrop:56:2026-09-21:airdrop_holders")));
  const entries = f.leaves.map((l) => ({ account: l.account, amount: BigInt(l.amount) }));
  const plan = merklePlan(entries);
  assert.equal(plan.root, f.root);
  plan.proofs.forEach((p, i) => assert.ok(verifyProof(f.root, merkleLeaf(entries[i].account, entries[i].amount), p)));
  assert.deepEqual(checkLeafFile(f), { root: f.root, total: 1000n });
  assert.equal(sampleFile(10_000n), null);
});

test("leaf file: any tampering is refused", () => {
  const bad = (mut: (f: any) => void) => {
    const f: any = JSON.parse(JSON.stringify(sampleFile()));
    mut(f);
    return () => checkLeafFile(f);
  };
  assert.throws(bad((f) => { f.leaves[0].amount = String(BigInt(f.leaves[0].amount) + 1n); }), /total/);
  assert.throws(bad((f) => { f.leaves[0].amount = String(BigInt(f.leaves[0].amount) + 1n); f.total = String(BigInt(f.total) + 1n); }), /campaign amounts/);
  assert.throws(bad((f) => { f.leaves[0].account = "0x00000000000000000000000000000000000000a9"; }), /root/);
  assert.throws(bad((f) => { f.leaves.push({ ...f.leaves[0] }); }), /duplicate/);
  assert.throws(bad((f) => { f.batchId = holderBatchId(4663, "2026-09-21"); }), /batch id/);
  assert.throws(bad((f) => { f.leaves[1].amount = "0"; }), /non-positive/);
});

test("the Safe signers' script, the weekly airdrop tree and the worker agree on the root", async () => {
  const f = sampleFile();
  const scriptPath = new URL("../../../scripts/evm-holder-batch-verify.mjs", import.meta.url).href;
  const script: any = await import(scriptPath);
  assert.deepEqual(script.checkLeafFile(f), { root: f.root, total: 1000n });
  assert.equal(script.holderBatchId(56, "2026-09-21"), f.batchId);
  const tampered = JSON.parse(JSON.stringify(f));
  tampered.leaves[0].amount = String(BigInt(tampered.leaves[0].amount) - 1n);
  tampered.leaves[1].amount = String(BigInt(tampered.leaves[1].amount) + 1n);
  assert.throws(() => script.checkLeafFile(tampered), /root/);
  // Five leaves (odd promotion) through all three implementations.
  const five = [1, 2, 3, 4, 5].map((i) => ({ account: ethers.getAddress(`0x${String(i).padStart(40, "0")}`), amount: BigInt(i * 1000) }));
  assert.equal(script.merkleRoot(five), merklePlan(five).root);
});

test("holder census folds Transfer logs: mints, moves and burns", () => {
  const iface = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
  const log = (from: string, to: string, v: bigint) => iface.encodeEventLog("Transfer", [from, to, v]);
  const a = "0x00000000000000000000000000000000000000a1";
  const b = "0x00000000000000000000000000000000000000a2";
  const bal = foldTransfers([log(ethers.ZeroAddress, a, 100n), log(a, b, 30n), log(b, ethers.ZeroAddress, 30n)]);
  assert.deepEqual([...bal], [[a, 70n]]);
});

test("operator key: refuses the deployer, the Safe and configured addresses; config reads per chain", () => {
  assert.throws(() => assertOperatorKeyAllowed("0x77F96A7d3bEA7a090aacbd00A50002D2b9AE0714"), /refuses/);
  assert.throws(() => assertOperatorKeyAllowed("0x1edcEdf5E5D9C2FAd5F9F6B964077dD74020A7A7"), /refuses/);
  const w = ethers.Wallet.createRandom();
  assert.throws(() => assertOperatorKeyAllowed(w.address, { EVM_CREATOR_CHOICE_FORBIDDEN_ADDRESSES: w.address }), /refuses/);
  assert.doesNotThrow(() => assertOperatorKeyAllowed(w.address, {}));
  assert.equal(operatorWallet(56, { EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY_56: w.privateKey })!.address, w.address);
  assert.equal(operatorWallet(4663, { EVM_CREATOR_CHOICE_OPERATOR_PRIVATE_KEY_56: w.privateKey }), null);
  assert.deepEqual(enabledChoiceChains({ EVM_CREATOR_CHOICE_ENABLED_56: "true", EVM_CREATOR_CHOICE_ENABLED_4663: "0" }), [56]);
  assert.equal(vaultAddress(56, { EVM_CREATOR_VAULT_V2_56: "0x00000000000000000000000000000000000000aa@123" }), "0x00000000000000000000000000000000000000AA");
  const cfg = choiceConfig(4663, { EVM_BUYBACK_SEED_SECRET: "s", EVM_HOLDER_EXCLUDED_WALLETS_4663: "0x00000000000000000000000000000000000000A1,junk", EVM_HOLDER_BATCH_MAX_WEI: "9" });
  assert.equal(cfg.masterSecret, "s");
  assert.deepEqual([...cfg.excluded], ["0x00000000000000000000000000000000000000a1"]);
  assert.equal(cfg.holderBatchMaxWei, 9n);
  assert.equal(cfg.minSpendWei, 1_000_000_000_000_000n);
  assert.equal(cfg.claimWindowDays, 60);
});
