import { expect } from "chai";
import { ethers } from "hardhat";
import { createAuthorizedBatch } from "./helpers/settlementAuth";

function leafFor(account: string, amount: bigint) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, amount]);
  return ethers.keccak256(ethers.concat([ethers.keccak256(encoded)]));
}

async function increaseTime(seconds: number) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("RewardDistributor audit hardening", function () {
  async function deployFixture() {
    const [owner, user, recovery] = await ethers.getSigners();
    const RewardDistributor = await ethers.getContractFactory("RewardDistributor");
    const distributor = await RewardDistributor.deploy(await owner.getAddress());
    await distributor.waitForDeployment();
    return { distributor, owner, user, recovery };
  }

  it("rescues only direct excess native value without touching batch liabilities", async () => {
    const { distributor, owner, user, recovery } = await deployFixture();
    const batchAmount = ethers.parseEther("1");
    const excessAmount = ethers.parseEther("0.25");
    const batchId = ethers.id("direct-excess");
    const root = leafFor(await user.getAddress(), batchAmount);
    const recoveryAddress = await recovery.getAddress();

    await createAuthorizedBatch(distributor, owner, batchId, root, 0, batchAmount);
    await owner.sendTransaction({ to: await distributor.getAddress(), value: excessAmount });

    expect(await distributor.totalOutstandingRewards()).to.equal(batchAmount);
    expect(await distributor.excessNativeBalance()).to.equal(excessAmount);

    await expect(distributor.connect(owner).rescueExcessNative(ethers.ZeroAddress, excessAmount)).to.be.revertedWithCustomError(
      distributor,
      "ZeroAddress"
    );
    await expect(distributor.connect(owner).rescueExcessNative(recoveryAddress, excessAmount + 1n)).to.be.revertedWithCustomError(
      distributor,
      "InsufficientExcessNative"
    );

    await expect(() => distributor.connect(owner).rescueExcessNative(recoveryAddress, excessAmount)).to.changeEtherBalances(
      [distributor, recovery],
      [-excessAmount, excessAmount]
    );
    expect(await distributor.totalOutstandingRewards()).to.equal(batchAmount);
    expect(await distributor.excessNativeBalance()).to.equal(0n);
  });

  it("rejects zero-address recovery recipients for unclaimed batch funds", async () => {
    const { distributor, owner, user } = await deployFixture();
    const amount = ethers.parseEther("0.5");
    const batchId = ethers.id("zero-recovery-recipient");
    const root = leafFor(await user.getAddress(), amount);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;

    await createAuthorizedBatch(distributor, owner, batchId, root, now + 10, amount);
    await increaseTime(11);

    await expect(distributor.connect(owner).recoverUnclaimed(batchId, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      distributor,
      "ZeroAddress"
    );
    expect(await distributor.totalOutstandingRewards()).to.equal(amount);
  });
});
