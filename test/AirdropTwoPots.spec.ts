import { expect } from "chai";
import { ethers } from "hardhat";
import { increaseTime, latestTs } from "./helpers/settlementAuth";
import { buildBatch } from "../scripts/make-safe-batch";
import { recoveryCalls, weeklyContractBatchId as recoveryBatchId } from "../scripts/make-airdrop-recovery-batch";
import { weeklyContractBatchId } from "../frontend/scripts/weekly-airdrop/materialize.mjs";
// @ts-ignore -- plain ESM script
import { airdropSetupCalls } from "../scripts/make-airdrop-setup-calls.mjs";

/**
 * Two airdrop pots per chain (founder, 2026-10-08): the main CommunityRewardsVault + its RewardDistributor
 * and the gen-7 vault (onlyRouter = the gen-7 router) + a second airdrop RewardDistributor. Rehearses on
 * the real contracts: the ONE setup Safe batch from make-airdrop-setup-calls.mjs (wiring + both pots'
 * authorizations), the operator key funding each pot with its own ids, claims from each distributor,
 * and the recovery batch returning each pot's unclaimed money to its own vault.
 */
describe("Airdrop: two pots (main + gen-7)", function () {
  const leaf = (addr: string, amount: bigint) =>
    ethers.keccak256(ethers.concat([ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, amount]))]));
  const pairRoot = (a: string, b: string) => {
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    return ethers.keccak256(ethers.concat([lo, hi]));
  };

  async function fixture() {
    const [safe, mainRouter, gen7Router, operator, alice, bob, carol, dave] = await ethers.getSigners();
    const D = await ethers.getContractFactory("RewardDistributor");
    const V = await ethers.getContractFactory("CommunityRewardsVault");
    const mainDist = await D.deploy(await safe.getAddress());
    const mainVault = await V.deploy(await safe.getAddress(), await mainRouter.getAddress());
    const gen7Dist = await D.deploy(await safe.getAddress());
    const gen7Vault = await V.deploy(await safe.getAddress(), await gen7Router.getAddress());
    await mainVault.connect(mainRouter).depositAirdrop({ value: ethers.parseEther("3") });
    await gen7Vault.connect(gen7Router).depositAirdrop({ value: ethers.parseEther("2") });

    const now = await latestTs();
    const calls = airdropSetupCalls({
      chainId: 56,
      weeks: 2,
      now: new Date(now * 1000),
      pots: [
        { pot: "main", vault: await mainVault.getAddress(), distributor: await mainDist.getAddress(), cap: ethers.parseEther("5"), operator: await operator.getAddress(), wire: true },
        { pot: "gen7", vault: await gen7Vault.getAddress(), distributor: await gen7Dist.getAddress(), cap: ethers.parseEther("5"), operator: await operator.getAddress(), wire: true },
      ],
    });
    const batch = buildBatch(56, "airdrop setup", "two pots", calls);
    for (const tx of batch.transactions) await (await safe.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) })).wait();
    const firstAuth = calls.find((c: any) => c.fn === "authorizeBatch");
    const publishAfter = Number(firstAuth.args[2]);
    const epochId = new Date((publishAfter - 7 * 86_400) * 1000).toISOString().slice(0, 10);
    return { safe, mainRouter, gen7Router, operator, alice, bob, carol, dave, mainDist, mainVault, gen7Dist, gen7Vault, publishAfter, epochId, calls };
  }

  it("one Safe batch wires and pre-authorizes both pots", async () => {
    const f = await fixture();
    expect(await f.mainVault.rewardDistributor()).to.equal(await f.mainDist.getAddress());
    expect(await f.gen7Vault.rewardDistributor()).to.equal(await f.gen7Dist.getAddress());
    expect(await f.mainDist.batchOperator()).to.equal(await f.mainVault.getAddress());
    expect(await f.gen7Dist.batchOperator()).to.equal(await f.gen7Vault.getAddress());
    expect(await f.gen7Vault.airdropOperator()).to.equal(await f.operator.getAddress());
    const mainId = weeklyContractBatchId(56, f.epochId, "airdrop_trader");
    const gen7Id = weeklyContractBatchId(56, f.epochId, "airdrop_trader", "gen7");
    expect((await f.mainDist.batchAuthorization(mainId)).authorized).to.equal(true);
    expect((await f.gen7Dist.batchAuthorization(gen7Id)).authorized).to.equal(true);
    expect((await f.mainDist.batchAuthorization(gen7Id)).authorized).to.equal(false);
    expect((await f.gen7Dist.batchAuthorization(mainId)).authorized).to.equal(false);
  });

  it("each pot funds its own week from its own vault; ids and distributors do not cross; claims and recovery stay per pot", async () => {
    const f = await fixture();
    await increaseTime(f.publishAfter - (await latestTs()) + 60);
    const now = await latestTs();
    const claimDeadline = now + 60 * 86_400;
    const mainId = weeklyContractBatchId(56, f.epochId, "airdrop_trader");
    const gen7Id = weeklyContractBatchId(56, f.epochId, "airdrop_trader", "gen7");
    expect(recoveryBatchId(56, f.epochId, "airdrop_trader", "gen7")).to.equal(gen7Id);

    const [a, b, c, d] = await Promise.all([f.alice, f.bob, f.carol, f.dave].map((s) => s.getAddress()));
    const mainLeaves = [leaf(a, ethers.parseEther("1")), leaf(b, ethers.parseEther("2"))];
    const gen7Leaves = [leaf(c, ethers.parseEther("0.5")), leaf(d, ethers.parseEther("1.5"))];

    // The gen-7 id is not authorized on the main distributor: the main vault cannot spend it.
    await expect(f.mainVault.connect(f.operator).fundAirdropBatch(gen7Id, pairRoot(gen7Leaves[0], gen7Leaves[1]), claimDeadline, ethers.parseEther("2")))
      .to.be.revertedWithCustomError(f.mainDist, "BatchNotAuthorized");

    await f.mainVault.connect(f.operator).fundAirdropBatch(mainId, pairRoot(mainLeaves[0], mainLeaves[1]), claimDeadline, ethers.parseEther("3"));
    await f.gen7Vault.connect(f.operator).fundAirdropBatch(gen7Id, pairRoot(gen7Leaves[0], gen7Leaves[1]), claimDeadline, ethers.parseEther("2"));
    expect(await f.mainVault.warzoneAirdropBalance()).to.equal(0n);
    expect(await f.gen7Vault.warzoneAirdropBalance()).to.equal(0n);
    expect(await ethers.provider.getBalance(await f.mainDist.getAddress())).to.equal(ethers.parseEther("3"));
    expect(await ethers.provider.getBalance(await f.gen7Dist.getAddress())).to.equal(ethers.parseEther("2"));

    // A gen-7 winner claims from the gen-7 distributor; the main distributor does not know that batch.
    await expect(f.mainDist.connect(f.carol).claim(gen7Id, ethers.parseEther("0.5"), [gen7Leaves[1]])).to.be.revertedWithCustomError(f.mainDist, "BatchMissing");
    await f.gen7Dist.connect(f.carol).claim(gen7Id, ethers.parseEther("0.5"), [gen7Leaves[1]]);
    await f.mainDist.connect(f.alice).claim(mainId, ethers.parseEther("1"), [mainLeaves[1]]);

    // 60 days later: one recovery batch, a block per pot, each back into its own vault, routers restored.
    await increaseTime(60 * 86_400 + 60);
    const safe = await f.safe.getAddress();
    const calls = [
      ...recoveryCalls({ safe, distributor: await f.mainDist.getAddress(), vault: await f.mainVault.getAddress(), router: await f.mainRouter.getAddress(), expired: [{ batchId: mainId, label: "main", unclaimed: ethers.parseEther("2") }] }),
      ...recoveryCalls({ safe, distributor: await f.gen7Dist.getAddress(), vault: await f.gen7Vault.getAddress(), router: await f.gen7Router.getAddress(), expired: [{ batchId: gen7Id, label: "gen7", unclaimed: ethers.parseEther("1.5") }] }),
    ];
    const batch = buildBatch(56, "recovery", "two pots", calls as any);
    for (const tx of batch.transactions) await (await f.safe.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) })).wait();
    expect(await f.mainVault.warzoneAirdropBalance()).to.equal(ethers.parseEther("2"));
    expect(await f.gen7Vault.warzoneAirdropBalance()).to.equal(ethers.parseEther("1.5"));
    expect(await f.mainVault.router()).to.equal(await f.mainRouter.getAddress());
    expect(await f.gen7Vault.router()).to.equal(await f.gen7Router.getAddress());
    expect(await f.mainDist.totalOutstandingRewards()).to.equal(0n);
    expect(await f.gen7Dist.totalOutstandingRewards()).to.equal(0n);
  });

  it("one distributor serves one vault: the gen-7 vault cannot create batches on the main distributor", async () => {
    const f = await fixture();
    await f.gen7Vault.connect(f.safe).setRewardDistributor(await f.mainDist.getAddress());
    await increaseTime(f.publishAfter - (await latestTs()) + 60);
    const mainId = weeklyContractBatchId(56, f.epochId, "airdrop_trader");
    await expect(f.gen7Vault.connect(f.operator).fundAirdropBatch(mainId, ethers.id("root"), (await latestTs()) + 86_400, ethers.parseEther("1")))
      .to.be.revertedWithCustomError(f.mainDist, "NotBatchOperator");
  });
});
