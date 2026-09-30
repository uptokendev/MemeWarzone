import { expect } from "chai";
import { ethers, network } from "hardhat";
import { buildBatch } from "../scripts/make-safe-batch";
import { attributeUnclaimed, holderRecoveryCalls, type HolderLeafFile } from "../scripts/make-holder-recovery-batch";
import { holderBatchId, merkleLeaf, merkleRoot } from "../scripts/evm-holder-batch-verify.mjs";

/**
 * E19: unclaimed holder payouts go back to the same coin's holders. A full holder week on
 * CreatorRewardsVaultV2 + the holder RewardDistributor, partial claims, the claim window runs out, and the Safe
 * batch written by scripts/make-holder-recovery-batch.ts returns each coin's unclaimed share to that coin's
 * holderBalance. The Safe is MockSafeBatchExecutor (msg.sender for every call, all or nothing, like MultiSend).
 */
const E18 = 10n ** 18n;
const DAY = 86_400;
const KEEP = 1, HOLDERS = 2, SPLIT = 3, BUYBACK = 4;

async function increase(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

function hashPair(a: string, b: string) {
  return ethers.keccak256(ethers.concat(a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a]));
}

/** Proofs for the tree evm-holder-batch-verify.mjs merkleRoot builds (leaves in order, odd node promoted). */
function proofs(entries: Array<{ account: string; amount: bigint }>): string[][] {
  const levels = [entries.map((e) => merkleLeaf(e.account, e.amount))];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  return entries.map((_, leafIndex) => {
    const proof: string[] = [];
    let index = leafIndex;
    for (let l = 0; l < levels.length - 1; l += 1) {
      const pair = index % 2 === 0 ? index + 1 : index - 1;
      if (pair < levels[l].length) proof.push(levels[l][pair]);
      index = Math.floor(index / 2);
    }
    return proof;
  });
}

async function fixture() {
  const [admin, operator, creator, trader, other, w1, w2, w3, w4] = await ethers.getSigners();
  const safe = await (await ethers.getContractFactory("MockSafeBatchExecutor")).deploy();
  const safeAddr = await safe.getAddress();
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const monthly = await Receiver.deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(admin.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
  const vault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(safeAddr, await router.getAddress(), await weth.getAddress(), 1, await topazFactory.getAddress(), DAY);
  await router.setRecruiterRewardsVault(await (await Receiver.deploy()).getAddress());
  await router.setCommunityRewardsVault(await (await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy()).getAddress());
  await router.setProtocolRevenueVault(await (await Receiver.deploy()).getAddress());
  await router.setCreatorRewardsVault(await vault.getAddress());
  const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(admin.address);
  const factory = await (await ethers.getContractFactory("MockFactoryEvmGen")).deploy(await locker.getAddress());
  const distributor = await (await ethers.getContractFactory("RewardDistributor")).deploy(safeAddr);

  const V = vault.interface;
  const D = distributor.interface;
  const asSafe = (calls: Array<{ to: string; data: string; value?: bigint }>) => safe.execBatch(calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data })));
  const vA = await vault.getAddress();
  const dA = await distributor.getAddress();
  await asSafe([
    { to: vA, data: V.encodeFunctionData("setFactoryOnce", [await factory.getAddress()]) },
    { to: vA, data: V.encodeFunctionData("setHolderDistributorOnce", [dA]) },
    { to: vA, data: V.encodeFunctionData("setOperator", [operator.address, false]) },
    { to: vA, data: V.encodeFunctionData("setCaps", [E18, 3n * E18, 3600, 50, 10n * E18]) },
    { to: dA, data: D.encodeFunctionData("setBatchOperator", [vA]) },
  ]);

  async function campaignWith(choice: number, pct = 0) {
    const campaign = await (await ethers.getContractFactory("MockCampaignEvmGen")).deploy(await router.getAddress(), 100n * E18);
    await factory.addCampaign(await campaign.getAddress());
    await factory.choose(vA, await campaign.getAddress(), creator.address, choice, pct);
    return campaign;
  }
  const A = await campaignWith(HOLDERS);
  const B = await campaignWith(SPLIT, 30);
  const K = await campaignWith(KEEP);
  const Bb = await campaignWith(BUYBACK);
  for (const c of [A, B, K, Bb]) await c.connect(trader).payFee(1, { value: E18 });
  const a = await A.getAddress();
  const b = await B.getAddress();

  // One holder week: both coins' whole holder balance, pro rata to four wallets (w1 and w4 hold both coins).
  const potA = await vault.holderBalance(a);
  const potB = await vault.holderBalance(b);
  const shareA = new Map([[w1.address, potA - (potA * 3n) / 10n * 2n], [w2.address, (potA * 3n) / 10n], [w4.address, (potA * 3n) / 10n]]);
  const shareB = new Map([[w1.address, potB - (potB / 4n) * 2n], [w3.address, potB / 4n], [w4.address, potB / 4n]]);
  const accounts = [w1, w2, w3, w4].map((w) => w.address).sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
  const [ca, cb] = [ethers.getAddress(a), ethers.getAddress(b)].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
  const shareOf = (c: string) => (c === ethers.getAddress(a) ? shareA : shareB);
  const leaves = accounts.map((acc) => {
    const parts = [ca, cb].filter((c) => shareOf(c).has(acc)).map((c) => ({ campaign: c, amount: shareOf(c).get(acc)!.toString() }));
    return { account: acc, amount: parts.reduce((s, p) => s + BigInt(p.amount), 0n).toString(), parts };
  });
  const entries = leaves.map((l) => ({ account: l.account, amount: BigInt(l.amount) }));
  const total = potA + potB;
  const weekId = "2026-10-05";
  const batchId = holderBatchId(56, weekId);
  const root = merkleRoot(entries);
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const claimDeadline = now + DAY + 60 * DAY;
  const campaignsCalldata = [ca, cb];
  const amountsCalldata = campaignsCalldata.map((c) => (c === ethers.getAddress(a) ? potA : potB));
  const file: HolderLeafFile = {
    kind: "mwz-evm-holder-batch", version: 1, chainId: 56, vault: vA, holderDistributor: dA, weekId, batchId, claimDeadline, root, total: total.toString(),
    campaigns: campaignsCalldata.map((c, i) => ({ campaign: c, amount: amountsCalldata[i].toString() })),
    leaves,
  };

  await vault.connect(operator).proposeHolderBatch(batchId, root, claimDeadline, campaignsCalldata, amountsCalldata);
  await asSafe([
    { to: vA, data: V.encodeFunctionData("approveHolderBatch", [batchId, root, total]) },
    { to: dA, data: D.encodeFunctionData("authorizeBatch", [batchId, total, now, now + 7 * DAY]) },
  ]);
  await increase(DAY);
  await vault.connect(operator).executeHolderBatch(batchId);
  expect(await distributor.unclaimed(batchId)).to.equal(total);

  // Partial claims: w1 and w3 claim; w2 and w4 never do.
  const pr = proofs(entries);
  for (const w of [w1, w3]) {
    const i = accounts.indexOf(w.address);
    await distributor.connect(w).claim(batchId, entries[i].amount, pr[i]);
  }
  const expectA = shareA.get(w2.address)! + shareA.get(w4.address)!;
  const expectB = shareB.get(w4.address)!;
  return { admin, operator, other, safe, safeAddr, vault, distributor, A, B, K, Bb, a, b, file, batchId, expectA, expectB, claimDeadline, asSafe };
}

async function onChain(distributor: any, batchId: string) {
  const b = await distributor.batches(batchId);
  return { merkleRoot: b.merkleRoot, totalFunded: BigInt(b.totalFunded), totalClaimed: BigInt(b.totalClaimed), claimDeadline: BigInt(b.claimDeadline), exists: b.exists };
}

async function claimedFn(distributor: any, file: HolderLeafFile) {
  const s = new Set<string>();
  for (const l of file.leaves) if (await distributor.hasClaimed(file.batchId, l.account)) s.add(l.account.toLowerCase());
  return (acc: string) => s.has(acc.toLowerCase());
}

describe("E19 holder recovery batch (unclaimed -> the same coins' holders)", function () {
  it("returns each coin's exact unclaimed share to its holderBalance through one Safe batch; replay reverts", async function () {
    const f = await fixture();
    const nowBefore = (await ethers.provider.getBlock("latest"))!.timestamp;
    const claimed = await claimedFn(f.distributor, f.file);

    // Before the deadline: the script refuses and the chain refuses.
    const open = await onChain(f.distributor, f.batchId);
    expect(() => attributeUnclaimed(f.file, open, claimed, nowBefore)).to.throw(/claim window open/);
    await expect(f.asSafe([{ to: await f.distributor.getAddress(), data: f.distributor.interface.encodeFunctionData("recoverUnclaimed", [f.batchId, f.safeAddr]) }]))
      .to.be.revertedWithCustomError(f.distributor, "BatchStillOpen");

    await increase(61 * DAY + 60);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const att = attributeUnclaimed(f.file, await onChain(f.distributor, f.batchId), claimed, now);
    expect(att.total).to.equal(f.expectA + f.expectB);
    expect(att.total).to.equal(await f.distributor.unclaimed(f.batchId));
    const calls = holderRecoveryCalls({ safe: f.safeAddr, distributor: f.file.holderDistributor, vault: f.file.vault, batchId: f.batchId, campaigns: att.campaigns, amounts: att.amounts });
    const batch = buildBatch(56, "holder recovery", "rehearsal", calls as any);
    expect(batch.transactions.map((t: any) => t.contractMethod.name)).to.deep.equal(["recoverUnclaimed", "creditUnclaimedHolders"]);
    expect(batch.transactions[1].value).to.equal(att.total.toString());
    const txs = batch.transactions.map((t: any) => ({ to: t.to, data: t.data, value: BigInt(t.value) }));

    // All or nothing: the same batch with a credit worth 1 wei less reverts, the recovery included.
    const short = [...att.amounts];
    short[0] -= 1n;
    const bad = [txs[0], { ...txs[1], data: f.vault.interface.encodeFunctionData("creditUnclaimedHolders", [att.campaigns, short]) }];
    await expect(f.asSafe(bad)).to.be.revertedWithCustomError(f.vault, "ValueMismatch");
    expect(await f.distributor.unclaimed(f.batchId)).to.equal(att.total);

    const holderA = await f.vault.holderBalance(f.a);
    const holderB = await f.vault.holderBalance(f.b);
    const liab = await f.vault.totalLiabilities();
    await expect(f.asSafe(txs))
      .to.emit(f.vault, "HolderUnclaimedCredited").withArgs(ethers.getAddress(f.a), f.expectA)
      .and.to.emit(f.vault, "HolderUnclaimedCredited").withArgs(ethers.getAddress(f.b), f.expectB);
    expect(await f.vault.holderBalance(f.a)).to.equal(holderA + f.expectA);
    expect(await f.vault.holderBalance(f.b)).to.equal(holderB + f.expectB);
    expect(await f.vault.totalLiabilities()).to.equal(liab + att.total);
    expect(await ethers.provider.getBalance(await f.vault.getAddress())).to.be.gte(await f.vault.totalLiabilities());
    expect(await ethers.provider.getBalance(f.safeAddr)).to.equal(0n); // the Safe ends with nothing extra
    expect(await f.distributor.unclaimed(f.batchId)).to.equal(0n);
    expect(await f.distributor.totalOutstandingRewards()).to.equal(0n);
    // Keep and buyback coins untouched.
    expect(await f.vault.holderBalance(await f.K.getAddress())).to.equal(0n);
    expect(await f.vault.holderBalance(await f.Bb.getAddress())).to.equal(0n);

    // Replay dies in its first call; nothing is credited twice. The script refuses too.
    await expect(f.asSafe(txs)).to.be.revertedWithCustomError(f.distributor, "AmountZero");
    expect(await f.vault.holderBalance(f.a)).to.equal(holderA + f.expectA);
    const after = await onChain(f.distributor, f.batchId);
    expect(() => attributeUnclaimed(f.file, after, claimed, now)).to.throw(/already recovered/);
  });

  it("the script refuses a file without parts, a tampered attribution, a wrong root or claims that do not add up", async function () {
    const f = await fixture();
    await increase(61 * DAY + 60);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const batch = await onChain(f.distributor, f.batchId);
    const claimed = await claimedFn(f.distributor, f.file);
    const copy = () => JSON.parse(JSON.stringify(f.file)) as HolderLeafFile;

    const noParts = copy();
    noParts.leaves.forEach((l) => delete l.parts);
    expect(() => attributeUnclaimed(noParts, batch, claimed, now)).to.throw(/no per-campaign parts/);

    const moved = copy(); // one wei moved from one coin to the other inside a two-coin leaf: sums per leaf hold, per coin not
    const leaf = moved.leaves.find((l) => l.parts!.length === 2)!;
    leaf.parts![0].amount = String(BigInt(leaf.parts![0].amount) - 1n);
    leaf.parts![1].amount = String(BigInt(leaf.parts![1].amount) + 1n);
    expect(() => attributeUnclaimed(moved, batch, claimed, now)).to.throw(/leaf parts for/);

    expect(() => attributeUnclaimed(f.file, { ...batch, merkleRoot: ethers.ZeroHash }, claimed, now)).to.throw(/root/);
    expect(() => attributeUnclaimed(f.file, { ...batch, claimDeadline: batch.claimDeadline + 1n }, claimed, now)).to.throw(/deadline/);
    expect(() => attributeUnclaimed(f.file, batch, () => false, now)).to.throw(/claimed leaves add up/);
    expect(() => attributeUnclaimed(f.file, { ...batch, totalFunded: batch.totalFunded + 1n }, claimed, now)).to.throw(/funded/);
  });

  it("creditUnclaimedHolders: admin only, exact value, holders/split coins only, no zero legs", async function () {
    const f = await fixture();
    const vA = await f.vault.getAddress();
    const V = f.vault.interface;
    const credit = (cs: string[], as: bigint[], value: bigint) => f.asSafe([{ to: vA, data: V.encodeFunctionData("creditUnclaimedHolders", [cs, as]), value }]);
    await network.provider.send("hardhat_setBalance", [f.safeAddr, "0x56BC75E2D63100000"]);

    await expect(f.vault.connect(f.admin).creditUnclaimedHolders([f.a], [1n], { value: 1n })).to.be.revertedWithCustomError(f.vault, "OnlyAdmin");
    await expect(f.vault.connect(f.operator).creditUnclaimedHolders([f.a], [1n], { value: 1n })).to.be.revertedWithCustomError(f.vault, "OnlyAdmin");
    await expect(credit([f.a, f.b], [1n, 2n], 2n)).to.be.revertedWithCustomError(f.vault, "ValueMismatch");
    await expect(credit([f.a, f.b], [1n, 2n], 4n)).to.be.revertedWithCustomError(f.vault, "ValueMismatch");
    await expect(credit([f.other.address], [1n], 1n)).to.be.revertedWithCustomError(f.vault, "WrongChoice");
    await expect(credit([await f.K.getAddress()], [1n], 1n)).to.be.revertedWithCustomError(f.vault, "WrongChoice");
    await expect(credit([await f.Bb.getAddress()], [1n], 1n)).to.be.revertedWithCustomError(f.vault, "WrongChoice");
    await expect(credit([f.a], [0n], 0n)).to.be.revertedWithCustomError(f.vault, "Insufficient");
    await expect(credit([], [], 0n)).to.be.revertedWithCustomError(f.vault, "BadBatch");
    await expect(credit([f.a, f.b], [1n], 1n)).to.be.revertedWithCustomError(f.vault, "BadBatch");

    const before = await f.vault.holderBalance(f.a);
    await credit([f.a, f.b], [5n, 7n], 12n);
    expect(await f.vault.holderBalance(f.a)).to.equal(before + 5n);
  });
});
