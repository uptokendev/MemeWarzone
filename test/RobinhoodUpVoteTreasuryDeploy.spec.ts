import { expect } from "chai";
import { ethers } from "hardhat";
import { deployUpVoteTreasury } from "../scripts/deploy-robinhood-upvote-treasury";

describe("Robinhood UPVoteTreasury deployment", function () {
  it("deploys Safe-owned, forwards every UP vote to the ProtocolRevenueVault, needs no post-deploy configuration", async function () {
    const [deployer, safe, voter] = await ethers.getSigners();
    const vault = await (await ethers.getContractFactory("ProtocolRevenueVault")).deploy(safe.address);
    await vault.waitForDeployment();
    const vaultAddress = await vault.getAddress();

    const result = await deployUpVoteTreasury({ owner: safe.address, feeReceiver: vaultAddress });
    const treasury = await ethers.getContractAt("UPVoteTreasury", result.address);
    expect(await treasury.owner()).to.equal(safe.address);
    expect(await treasury.feeReceiver()).to.equal(vaultAddress);
    expect(await treasury.campaignAllowlistEnabled()).to.equal(false);

    // A $3 vote goes straight through to the vault; the treasury keeps nothing.
    const before = await ethers.provider.getBalance(vaultAddress);
    const campaign = ethers.Wallet.createRandom().address;
    await expect(treasury.connect(voter).voteWithBNB(campaign, ethers.ZeroHash, { value: ethers.parseEther("0.001") }))
      .to.emit(treasury, "VoteCast").withArgs(campaign, voter.address, ethers.ZeroAddress, ethers.parseEther("0.001"), ethers.ZeroHash);
    expect((await ethers.provider.getBalance(vaultAddress)) - before).to.equal(ethers.parseEther("0.001"));
    expect(await ethers.provider.getBalance(result.address)).to.equal(0n);

    // The deployer holds no power over it.
    await expect(treasury.connect(deployer).setFeeReceiver(deployer.address)).to.be.reverted;
  });

  it("refuses a fee receiver without code", async function () {
    const [, safe] = await ethers.getSigners();
    await expect(deployUpVoteTreasury({ owner: safe.address, feeReceiver: ethers.Wallet.createRandom().address }))
      .to.be.rejectedWith(/no code/);
  });
});
