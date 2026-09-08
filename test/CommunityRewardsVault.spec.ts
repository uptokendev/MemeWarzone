import { expect } from "chai";
import { ethers } from "hardhat";
import { authorizeBatch } from "./helpers/settlementAuth";

describe("CommunityRewardsVault", function () {
  async function deployFixture() {
    const [admin, router, operator, alice, bob] = await ethers.getSigners();

    const CommunityRewardsVault = await ethers.getContractFactory("CommunityRewardsVault");
    const vault = await CommunityRewardsVault.deploy(await admin.getAddress(), await router.getAddress());
    await vault.waitForDeployment();

    const RewardDistributor = await ethers.getContractFactory("RewardDistributor");
    const distributor = await RewardDistributor.deploy(await admin.getAddress());
    await distributor.waitForDeployment();

    return { vault, distributor, admin, router, operator, alice, bob };
  }

  async function fundTrackedAirdrop(vault: any, router: any, amount: bigint) {
    await vault.connect(router).depositAirdrop({ value: amount });
  }

  async function fundTrackedSquad(vault: any, router: any, amount: bigint) {
    await vault.connect(router).depositSquadPool({ value: amount });
  }

  it("validates constructor admin and rejects direct native deposits", async () => {
    const [admin, router] = await ethers.getSigners();
    const CommunityRewardsVault = await ethers.getContractFactory("CommunityRewardsVault");

    await expect(CommunityRewardsVault.deploy(ethers.ZeroAddress, await router.getAddress())).to.be.revertedWith("admin=0");

    const vault = await CommunityRewardsVault.deploy(await admin.getAddress(), await router.getAddress());
    await vault.waitForDeployment();

    await expect(admin.sendTransaction({ to: await vault.getAddress(), value: 1n })).to.be.revertedWith("direct disabled");
  });

  it("restricts admin configuration and validates reward distributor", async () => {
    const { vault, distributor, admin, operator, alice } = await deployFixture();
    const operatorAddress = await operator.getAddress();

    await expect(vault.connect(alice).setRouter(await alice.getAddress())).to.be.revertedWith("not admin");
    await expect(vault.connect(alice).setRewardDistributor(await distributor.getAddress())).to.be.revertedWith("not admin");
    await expect(vault.connect(alice).setAirdropOperator(operatorAddress)).to.be.revertedWith("not admin");
    await expect(vault.connect(admin).setRewardDistributor(ethers.ZeroAddress)).to.be.revertedWith("distributor=0");

    await expect(vault.connect(admin).setRouter(await alice.getAddress())).to.emit(vault, "RouterUpdated");
    await expect(vault.connect(admin).setRewardDistributor(await distributor.getAddress())).to.emit(
      vault,
      "RewardDistributorUpdated"
    );
    await expect(vault.connect(admin).setAirdropOperator(operatorAddress))
      .to.emit(vault, "AirdropOperatorUpdated")
      .withArgs(ethers.ZeroAddress, operatorAddress);

    expect(await vault.router()).to.eq(await alice.getAddress());
    expect(await vault.rewardDistributor()).to.eq(await distributor.getAddress());
    expect(await vault.airdropOperator()).to.eq(operatorAddress);
  });

  it("accepts only router deposits and tracks airdrop plus squad balances", async () => {
    const { vault, router, alice } = await deployFixture();
    const airdropAmount = ethers.parseEther("1");
    const squadAmount = ethers.parseEther("0.25");

    await expect(vault.connect(alice).depositAirdrop({ value: 1n })).to.be.revertedWith("not router");
    await expect(vault.connect(router).depositAirdrop({ value: 0n })).to.be.revertedWith("amount=0");
    await expect(vault.connect(alice).depositSquadPool({ value: 1n })).to.be.revertedWith("not router");
    await expect(vault.connect(router).depositSquadPool({ value: 0n })).to.be.revertedWith("amount=0");

    await expect(vault.connect(router).depositAirdrop({ value: airdropAmount }))
      .to.emit(vault, "AirdropDeposited")
      .withArgs(await router.getAddress(), airdropAmount, airdropAmount);
    await expect(vault.connect(router).depositSquadPool({ value: squadAmount }))
      .to.emit(vault, "SquadPoolDeposited")
      .withArgs(await router.getAddress(), squadAmount, squadAmount);

    expect(await vault.warzoneAirdropBalance()).to.eq(airdropAmount);
    expect(await vault.squadPoolBalance()).to.eq(squadAmount);
    expect(await vault.totalTracked()).to.eq(airdropAmount + squadAmount);
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.eq(airdropAmount + squadAmount);
  });

  it("withdraws tracked airdrop funds only by admin", async () => {
    const { vault, admin, router, alice, bob } = await deployFixture();
    const amount = ethers.parseEther("1");
    const withdrawal = ethers.parseEther("0.4");
    const bobAddress = await bob.getAddress();
    await fundTrackedAirdrop(vault, router, amount);

    await expect(vault.connect(alice).withdrawAirdrop(bobAddress, withdrawal)).to.be.revertedWith("not admin");
    await expect(vault.connect(admin).withdrawAirdrop(ethers.ZeroAddress, withdrawal)).to.be.revertedWith("to=0");
    await expect(vault.connect(admin).withdrawAirdrop(bobAddress, amount + 1n)).to.be.revertedWith(
      "tracked insufficient"
    );

    await expect(() => vault.connect(admin).withdrawAirdrop(bobAddress, withdrawal)).to.changeEtherBalances(
      [vault, bob],
      [-withdrawal, withdrawal]
    );
    expect(await vault.warzoneAirdropBalance()).to.eq(amount - withdrawal);
    expect(await vault.squadPoolBalance()).to.eq(0n);
  });

  it("withdraws tracked squad funds only by admin", async () => {
    const { vault, admin, router, alice, bob } = await deployFixture();
    const amount = ethers.parseEther("0.8");
    const withdrawal = ethers.parseEther("0.3");
    const bobAddress = await bob.getAddress();
    await fundTrackedSquad(vault, router, amount);

    await expect(vault.connect(alice).withdrawSquadPool(bobAddress, withdrawal)).to.be.revertedWith("not admin");
    await expect(vault.connect(admin).withdrawSquadPool(ethers.ZeroAddress, withdrawal)).to.be.revertedWith("to=0");
    await expect(vault.connect(admin).withdrawSquadPool(bobAddress, amount + 1n)).to.be.revertedWith(
      "tracked insufficient"
    );

    await expect(() => vault.connect(admin).withdrawSquadPool(bobAddress, withdrawal)).to.changeEtherBalances(
      [vault, bob],
      [-withdrawal, withdrawal]
    );
    expect(await vault.squadPoolBalance()).to.eq(amount - withdrawal);
    expect(await vault.warzoneAirdropBalance()).to.eq(0n);
  });

  it("preserves tracked balances when withdrawals cannot transfer native value", async () => {
    const { vault, admin, router } = await deployFixture();
    const RevertingReceiver = await ethers.getContractFactory("RevertingReceiver");
    const rejectingReceiver = await RevertingReceiver.deploy();
    await rejectingReceiver.waitForDeployment();
    const rejectingAddress = await rejectingReceiver.getAddress();

    await fundTrackedAirdrop(vault, router, 100n);
    await fundTrackedSquad(vault, router, 50n);

    await expect(vault.connect(admin).withdrawAirdrop(rejectingAddress, 25n)).to.be.revertedWith("transfer failed");
    await expect(vault.connect(admin).withdrawSquadPool(rejectingAddress, 25n)).to.be.revertedWith("transfer failed");

    expect(await vault.warzoneAirdropBalance()).to.eq(100n);
    expect(await vault.squadPoolBalance()).to.eq(50n);
    expect(await vault.totalTracked()).to.eq(150n);
  });

  it("guards airdrop batch funding before configuration and tracked funding", async () => {
    const { vault, distributor, admin, operator, router, alice } = await deployFixture();
    const batchId = ethers.id("guarded-batch");
    const root = ethers.keccak256(ethers.toUtf8Bytes("root"));
    const deadline = 0;

    await expect(vault.connect(alice).fundAirdropBatch(batchId, root, deadline, 1n)).to.be.revertedWith(
      "not airdrop operator"
    );
    await expect(vault.connect(admin).fundAirdropBatch(batchId, root, deadline, 1n)).to.be.revertedWith(
      "distributor unset"
    );

    await vault.connect(admin).setRewardDistributor(await distributor.getAddress());
    await vault.connect(admin).setAirdropOperator(await operator.getAddress());
    await expect(vault.connect(operator).fundAirdropBatch(batchId, root, deadline, 0n)).to.be.revertedWith("amount=0");
    await expect(vault.connect(operator).fundAirdropBatch(batchId, root, deadline, 1n)).to.be.revertedWith(
      "tracked insufficient"
    );

    await fundTrackedAirdrop(vault, router, 1n);
    await expect(vault.connect(operator).fundAirdropBatch(batchId, root, deadline, 1n)).to.be.revertedWithCustomError(
      distributor,
      "NotBatchOperator"
    );
  });

  it("funds a RewardDistributor batch from tracked airdrop funds", async () => {
    const { vault, distributor, admin, router } = await deployFixture();
    const batchId = ethers.id("funded-batch");
    const root = ethers.keccak256(ethers.toUtf8Bytes("root"));
    const deadline = 123456;
    const amount = ethers.parseEther("0.75");

    await fundTrackedAirdrop(vault, router, amount);
    await vault.connect(admin).setRewardDistributor(await distributor.getAddress());
    await distributor.connect(admin).setBatchOperator(await vault.getAddress());
    await authorizeBatch(distributor, admin, batchId, amount);

    await expect(vault.connect(admin).fundAirdropBatch(batchId, root, deadline, amount))
      .to.emit(vault, "AirdropBatchFunded")
      .withArgs(batchId, root, await distributor.getAddress(), amount, deadline, 0n);

    const batch = await distributor.batches(batchId);
    expect(batch.merkleRoot).to.eq(root);
    expect(batch.totalFunded).to.eq(amount);
    expect(batch.totalClaimed).to.eq(0n);
    expect(batch.claimDeadline).to.eq(deadline);
    expect(batch.exists).to.eq(true);
    expect(await vault.warzoneAirdropBalance()).to.eq(0n);
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.eq(0n);
    expect(await ethers.provider.getBalance(await distributor.getAddress())).to.eq(amount);
  });

  it("allows the configured airdrop operator to fund a batch", async () => {
    const { vault, distributor, admin, router, operator } = await deployFixture();
    const amount = ethers.parseEther("0.2");
    const batchId = ethers.id("operator-batch");
    const root = ethers.keccak256(ethers.toUtf8Bytes("operator-root"));

    await fundTrackedAirdrop(vault, router, amount);
    await vault.connect(admin).setRewardDistributor(await distributor.getAddress());
    await vault.connect(admin).setAirdropOperator(await operator.getAddress());
    await distributor.connect(admin).setBatchOperator(await vault.getAddress());
    await authorizeBatch(distributor, admin, batchId, amount);

    await expect(vault.connect(operator).fundAirdropBatch(batchId, root, 0, amount)).to.emit(
      distributor,
      "BatchCreated"
    );
    expect(await vault.warzoneAirdropBalance()).to.eq(0n);
    expect(await distributor.unclaimed(batchId)).to.eq(amount);
  });

  it("rolls back tracked accounting when distributor batch creation reverts", async () => {
    const { vault, distributor, admin, router } = await deployFixture();
    const amount = ethers.parseEther("0.1");
    const batchId = ethers.id("duplicate-batch");
    const root = ethers.keccak256(ethers.toUtf8Bytes("duplicate-root"));

    await fundTrackedAirdrop(vault, router, amount * 2n);
    await vault.connect(admin).setRewardDistributor(await distributor.getAddress());
    await distributor.connect(admin).setBatchOperator(await vault.getAddress());
    await authorizeBatch(distributor, admin, batchId, amount);

    await vault.connect(admin).fundAirdropBatch(batchId, root, 0, amount);
    await expect(vault.connect(admin).fundAirdropBatch(batchId, root, 0, amount)).to.be.revertedWithCustomError(
      distributor,
      "BatchExists"
    );

    expect(await vault.warzoneAirdropBalance()).to.eq(amount);
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.eq(amount);
    expect(await distributor.unclaimed(batchId)).to.eq(amount);
  });

  it("blocks airdrop operators from inventing a RewardDistributor batch without Safe authorization", async () => {
    const { vault, distributor, admin, router, operator } = await deployFixture();
    const amount = ethers.parseEther("0.3");
    const batchId = ethers.id("unauth-operator-batch");
    const root = ethers.keccak256(ethers.toUtf8Bytes("unauth-root"));

    await fundTrackedAirdrop(vault, router, amount);
    await vault.connect(admin).setRewardDistributor(await distributor.getAddress());
    await vault.connect(admin).setAirdropOperator(await operator.getAddress());
    await distributor.connect(admin).setBatchOperator(await vault.getAddress());

    await expect(vault.connect(operator).fundAirdropBatch(batchId, root, 0, amount)).to.be.revertedWithCustomError(
      distributor,
      "BatchNotAuthorized"
    );
    expect(await vault.warzoneAirdropBalance()).to.eq(amount);
  });
});
