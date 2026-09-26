import { expect } from "chai";
import { ethers } from "hardhat";
import { increaseTime, latestTs } from "./helpers/settlementAuth";
import { buildBatch } from "../scripts/make-safe-batch";
import { recoveryCalls, weeklyContractBatchId } from "../scripts/make-airdrop-recovery-batch";
import { weeklyContractBatchId as runnerBatchId } from "../frontend/scripts/weekly-airdrop/materialize.mjs";

/**
 * Rehearses scripts/make-airdrop-recovery-batch.ts: an airdrop batch nobody fully claimed goes back
 * into warzoneAirdropBalance after its 60-day window, through the exact Safe batch JSON.
 */
describe("Airdrop recovery batch (unclaimed -> next week's pot)", function () {
  async function fixture() {
    const [safe, router, operator, winner, loser] = await ethers.getSigners();
    const distributor = await (await ethers.getContractFactory("RewardDistributor")).deploy(await safe.getAddress());
    const vault = await (await ethers.getContractFactory("CommunityRewardsVault")).deploy(await safe.getAddress(), await router.getAddress());
    await vault.connect(safe).setRewardDistributor(await distributor.getAddress());
    await vault.connect(safe).setAirdropOperator(await operator.getAddress());
    await distributor.connect(safe).setBatchOperator(await vault.getAddress());
    await vault.connect(router).depositAirdrop({ value: ethers.parseEther("3") });

    // One week's batch: winner 1 BNB, loser 2 BNB (never claims). 60-day window.
    const batchId = weeklyContractBatchId(56, "2026-09-21", "airdrop_trader");
    const leafFor = (addr: string, amount: bigint) => ethers.keccak256(ethers.concat([ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, amount]))]));
    const a = leafFor(await winner.getAddress(), ethers.parseEther("1"));
    const b = leafFor(await loser.getAddress(), ethers.parseEther("2"));
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    const root = ethers.keccak256(ethers.concat([lo, hi]));
    const now = await latestTs();
    await distributor.connect(safe).authorizeBatch(batchId, ethers.parseEther("5"), now, now + 6 * 86_400);
    const claimDeadline = now + 60 * 86_400;
    await vault.connect(operator).fundAirdropBatch(batchId, root, claimDeadline, ethers.parseEther("3"));
    await distributor.connect(winner).claim(batchId, ethers.parseEther("1"), [b]);
    return { safe, router, distributor, vault, batchId, claimDeadline };
  }

  it("uses the runner's own batch id", () => {
    expect(weeklyContractBatchId(4663, "2026-10-05", "airdrop_creator")).to.equal(runnerBatchId(4663, "2026-10-05", "airdrop_creator"));
  });

  it("returns exactly the unclaimed amount to the airdrop pot and restores the router", async () => {
    const { safe, router, distributor, vault, batchId } = await fixture();
    expect(await vault.warzoneAirdropBalance()).to.equal(0n);
    const calls = recoveryCalls({ safe: await safe.getAddress(), distributor: await distributor.getAddress(), vault: await vault.getAddress(), router: await router.getAddress(), expired: [{ batchId, label: "w1", unclaimed: ethers.parseEther("2") }] });
    const batch = buildBatch(56, "recovery", "rehearsal", calls as any);
    expect(batch.transactions.find((t: any) => t.contractMethod.name === "depositAirdrop").value).to.equal(ethers.parseEther("2").toString());

    // Still open: the first call refuses, nothing moves.
    await expect(safe.sendTransaction({ to: batch.transactions[0].to, data: batch.transactions[0].data })).to.be.revertedWithCustomError(distributor, "BatchStillOpen");

    await increaseTime(60 * 86_400 + 60);
    for (const tx of batch.transactions) await (await safe.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) })).wait();
    expect(await vault.warzoneAirdropBalance()).to.equal(ethers.parseEther("2"));
    expect(await vault.router()).to.equal(await router.getAddress());
    expect(await distributor.totalOutstandingRewards()).to.equal(0n);

    // A replay of the same batch dies in its first call: nothing is deposited twice.
    await expect(safe.sendTransaction({ to: batch.transactions[0].to, data: batch.transactions[0].data })).to.be.revertedWithCustomError(distributor, "AmountZero");
  });

  it("the direct route the naive fix would use is refused by the vault", async () => {
    const { safe, distributor, vault, batchId } = await fixture();
    await increaseTime(60 * 86_400 + 60);
    await expect(distributor.connect(safe).recoverUnclaimed(batchId, await vault.getAddress())).to.be.revertedWithCustomError(distributor, "TransferFailed");
  });

  it("refuses to put value on a non-payable call", () => {
    expect(() => buildBatch(56, "x", "y", [{ contract: "CommunityRewardsVault", to: ethers.ZeroAddress, fn: "setRouter", args: [ethers.ZeroAddress], value: 1n }])).to.throw(/not payable/);
  });
});
