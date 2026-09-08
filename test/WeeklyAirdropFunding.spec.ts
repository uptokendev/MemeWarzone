import { expect } from "chai";
import { ethers } from "hardhat";
import { authorizeBatch } from "./helpers/settlementAuth";

function leafFor(account: string, amount: bigint) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, amount]);
  return ethers.keccak256(ethers.concat([ethers.keccak256(encoded)]));
}

describe("Weekly airdrop atomic funding", function () {
  async function deployFixture() {
    const [admin, router, operator, user, outsider] = await ethers.getSigners();

    const RewardDistributor = await ethers.getContractFactory("RewardDistributor");
    const distributor = await RewardDistributor.deploy(await admin.getAddress());
    await distributor.waitForDeployment();

    const CommunityRewardsVault = await ethers.getContractFactory("CommunityRewardsVault");
    const vault = await CommunityRewardsVault.deploy(await admin.getAddress(), await router.getAddress());
    await vault.waitForDeployment();

    await distributor.connect(admin).setBatchOperator(await vault.getAddress());
    await vault.connect(admin).setRewardDistributor(await distributor.getAddress());
    await vault.connect(admin).setAirdropOperator(await operator.getAddress());

    return { admin, router, operator, user, outsider, distributor, vault };
  }

  it("atomically funds a Merkle batch from the tracked airdrop pool", async () => {
    const { admin, router, operator, user, distributor, vault } = await deployFixture();
    const deposit = ethers.parseEther("1");
    const reward = ethers.parseEther("0.25");
    const batchId = ethers.id("weekly-airdrop-1");
    const root = leafFor(await user.getAddress(), reward);
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);

    await vault.connect(router).depositAirdrop({ value: deposit });
    await authorizeBatch(distributor, admin, batchId, reward);

    await expect(vault.connect(operator).fundAirdropBatch(batchId, root, deadline, reward))
      .to.emit(vault, "AirdropBatchFunded")
      .withArgs(batchId, root, await distributor.getAddress(), reward, deadline, deposit - reward);

    expect(await vault.warzoneAirdropBalance()).to.eq(deposit - reward);
    const batch = await distributor.batches(batchId);
    expect(batch.exists).to.eq(true);
    expect(batch.merkleRoot).to.eq(root);
    expect(batch.totalFunded).to.eq(reward);
    expect(batch.claimDeadline).to.eq(deadline);

    await expect(() => distributor.connect(user).claim(batchId, reward, [])).to.changeEtherBalances(
      [distributor, user],
      [-reward, reward],
    );
  });

  it("rejects unauthorized funding callers", async () => {
    const { router, outsider, user, vault } = await deployFixture();
    const reward = ethers.parseEther("0.1");
    const batchId = ethers.id("weekly-airdrop-unauthorized");
    const root = leafFor(await user.getAddress(), reward);

    await vault.connect(router).depositAirdrop({ value: reward });
    await expect(vault.connect(outsider).fundAirdropBatch(batchId, root, 0, reward)).to.be.revertedWith(
      "not airdrop operator",
    );
  });

  it("rejects operator funding without Safe batch authorization", async () => {
    const { router, operator, user, distributor, vault } = await deployFixture();
    const reward = ethers.parseEther("0.1");
    const batchId = ethers.id("weekly-airdrop-unauth-batch");
    const root = leafFor(await user.getAddress(), reward);

    await vault.connect(router).depositAirdrop({ value: reward });
    await expect(vault.connect(operator).fundAirdropBatch(batchId, root, 0, reward)).to.be.revertedWithCustomError(
      distributor,
      "BatchNotAuthorized"
    );
    expect(await vault.warzoneAirdropBalance()).to.eq(reward);
  });

  it("reverts the vault balance change when the distributor rejects a duplicate batch", async () => {
    const { admin, router, operator, user, distributor, vault } = await deployFixture();
    const deposit = ethers.parseEther("0.5");
    const reward = ethers.parseEther("0.1");
    const batchId = ethers.id("weekly-airdrop-duplicate");
    const root = leafFor(await user.getAddress(), reward);

    await vault.connect(router).depositAirdrop({ value: deposit });
    await authorizeBatch(distributor, admin, batchId, reward);
    await vault.connect(operator).fundAirdropBatch(batchId, root, 0, reward);
    const balanceAfterFirst = await vault.warzoneAirdropBalance();

    await expect(vault.connect(operator).fundAirdropBatch(batchId, root, 0, reward)).to.be.reverted;
    expect(await vault.warzoneAirdropBalance()).to.eq(balanceAfterFirst);
  });

  it("allows the owner to revoke the automated funding operator", async () => {
    const { admin, router, operator, user, vault } = await deployFixture();
    const reward = ethers.parseEther("0.1");
    const batchId = ethers.id("weekly-airdrop-revoked");
    const root = leafFor(await user.getAddress(), reward);

    await vault.connect(router).depositAirdrop({ value: reward });
    await vault.connect(admin).setAirdropOperator(ethers.ZeroAddress);

    await expect(vault.connect(operator).fundAirdropBatch(batchId, root, 0, reward)).to.be.revertedWith(
      "not airdrop operator",
    );
  });
});
