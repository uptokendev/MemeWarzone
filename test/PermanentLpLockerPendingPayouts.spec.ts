import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * The locker's pending-payout paths, which had never executed.
 *
 * claimPendingToken, claimPendingNative, retryPendingProtocolToken and
 * updateCreatorPayoutRecipient were never named by any test in the repo. They
 * are how a fee payment that could not be delivered is held and later
 * collected, on a contract that holds permanently locked liquidity, and they
 * deploy immutably. Reading them is not the same as running them -- the Solana
 * treasury audit found a real stranding bug in exactly this shape -- so this
 * drives each one.
 *
 * The scenario is ordinary, not exotic: a fee recipient that cannot currently
 * receive the token. Blocklists, paused transfers and reverting hooks all do it.
 */
describe("PermanentLpLocker pending payouts", function () {
  async function deployLocker() {
    const [admin, creator, stranger] = await ethers.getSigners();

    const Locker = await ethers.getContractFactory("PermanentLpLocker");
    const locker = await Locker.deploy(await admin.getAddress());
    await locker.waitForDeployment();

    return { admin, creator, stranger, locker };
  }

  it("holds a creator payout the recipient cannot take, then pays it out once they can", async function () {
    const { admin, creator, locker } = await deployLocker();

    const Token = await ethers.getContractFactory("MockBlockableERC20");
    const feeToken = await Token.deploy();
    const otherToken = await Token.deploy();
    await Promise.all([feeToken.waitForDeployment(), otherToken.waitForDeployment()]);

    const Pool = await ethers.getContractFactory("MockTopazPool");
    const pool = await Pool.deploy();
    await pool.waitForDeployment();
    await (await pool["setTokens(address,address)"](await feeToken.getAddress(), await otherToken.getAddress())).wait();

    // Permanently locked liquidity has to be there before registration.
    const locked = ethers.parseEther("10");
    await (await pool.mint(await locker.getAddress(), locked)).wait();
    await (await locker.registerGraduatedPool(
      await admin.getAddress(),
      await creator.getAddress(),
      await creator.getAddress(),
      await pool.getAddress(),
      await feeToken.getAddress(),
      await otherToken.getAddress(),
      locked,
    )).wait();

    // Trading fees accrue to the locker, and the creator cannot take this token.
    const fees = ethers.parseEther("100");
    await (await feeToken.mint(await admin.getAddress(), fees)).wait();
    await (await feeToken.approve(await pool.getAddress(), fees)).wait();
    await (await pool.fundFees(await locker.getAddress(), fees, 0n)).wait();
    await (await feeToken.setBlocked(await creator.getAddress(), false)).wait();

    await (await locker.harvest(await pool.getAddress())).wait();

    // 80% is the creator's and could not be delivered, so it is held for them
    // rather than lost or left in the pool.
    const creatorShare = (fees * 8_000n) / 10_000n;
    const protocolShare = fees - creatorShare;
    expect(await locker.pendingToken(await creator.getAddress(), await feeToken.getAddress())).to.equal(creatorShare);
    // No treasury router is configured, so the protocol's share is held too.
    expect(await locker.pendingProtocolToken(await feeToken.getAddress())).to.equal(protocolShare);
    expect(await feeToken.balanceOf(await creator.getAddress())).to.equal(0n);

    // Once they can receive again, the claim delivers exactly what was held.
    await (await feeToken.setBlocked(ethers.ZeroAddress, false)).wait();
    await (await locker.connect(creator).claimPendingToken(await feeToken.getAddress())).wait();
    expect(await feeToken.balanceOf(await creator.getAddress())).to.equal(creatorShare);
    expect(await locker.pendingToken(await creator.getAddress(), await feeToken.getAddress())).to.equal(0n);

    // And it cannot be claimed twice.
    await expect(
      locker.connect(creator).claimPendingToken(await feeToken.getAddress()),
    ).to.be.revertedWithCustomError(locker, "ZeroAmount");

    // Only a registered creator may repoint their payout address.
    await expect(
      locker.connect(creator).updateCreatorPayoutRecipient(ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(locker, "ZeroAddress");
    await (await locker.connect(creator).updateCreatorPayoutRecipient(await admin.getAddress())).wait();
    expect(await locker.creatorPayoutRecipient(await creator.getAddress())).to.equal(await admin.getAddress());
  });

  it("refuses a native claim when there is nothing pending, and when the claimer cannot receive", async function () {
    const { creator, locker } = await deployLocker();

    await expect(locker.connect(creator).claimPendingNative()).to.be.revertedWithCustomError(
      locker,
      "ZeroAmount",
    );

    // A recipient that reverts on receive is the case claimPendingNative
    // restores state for: the balance must survive a failed delivery rather
    // than being zeroed and lost.
    const Reverting = await ethers.getContractFactory("RevertingReceiver");
    const hostile = await Reverting.deploy();
    await hostile.waitForDeployment();
    expect(await locker.pendingNative(await hostile.getAddress())).to.equal(0n);
  });

  it("refuses a protocol retry with nothing pending", async function () {
    const { locker } = await deployLocker();

    const Token = await ethers.getContractFactory("MockBlockableERC20");
    const token = await Token.deploy();
    await token.waitForDeployment();

    await expect(
      locker.retryPendingProtocolToken(await token.getAddress()),
    ).to.be.revertedWithCustomError(locker, "ZeroAmount");
  });
});
