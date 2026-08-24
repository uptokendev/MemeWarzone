import { expect } from "chai";
import { ethers } from "hardhat";

async function deployToken(name: string, symbol: string, owner: any) {
  const Token = await ethers.getContractFactory("LaunchToken");
  const token = await Token.deploy(name, symbol, ethers.parseEther("1000"), await owner.getAddress());
  await token.waitForDeployment();
  await token.connect(owner).enableTrading();
  return token;
}

describe("PermanentLpLocker Topaz fee validation", function () {
  it("registers only volatile Topaz pools with the required 0.30% trading fee", async () => {
    const [owner, creator, feeRecipient, campaign] = await ethers.getSigners();

    const Locker = await ethers.getContractFactory("PermanentLpLocker");
    const locker = await Locker.deploy(await owner.getAddress());
    await locker.waitForDeployment();

    const token = await deployToken("Launch Token", "LAUNCH", owner);
    const wbnb = await deployToken("Wrapped BNB", "WBNB", owner);

    const Factory = await ethers.getContractFactory("MockTopazFeeFactory");
    const factory = await Factory.deploy(30);
    await factory.waitForDeployment();

    const Pool = await ethers.getContractFactory("MockTopazFeePool");
    const pool = await Pool.deploy(await factory.getAddress(), await token.getAddress(), await wbnb.getAddress(), false);
    await pool.waitForDeployment();
    await pool.mint(await locker.getAddress(), ethers.parseEther("1"));

    await locker.connect(owner).configureRevenue(await owner.getAddress(), await factory.getAddress());
    await expect(
      locker.connect(owner).registerGraduatedPool(
        await campaign.getAddress(),
        await creator.getAddress(),
        await feeRecipient.getAddress(),
        await pool.getAddress(),
        await token.getAddress(),
        await wbnb.getAddress(),
        ethers.parseEther("1")
      )
    ).to.emit(locker, "GraduationPoolRegistered");
  });

  it("rejects volatile Topaz pools that do not use the required 0.30% trading fee", async () => {
    const [owner, creator, feeRecipient, campaign] = await ethers.getSigners();

    const Locker = await ethers.getContractFactory("PermanentLpLocker");
    const locker = await Locker.deploy(await owner.getAddress());
    await locker.waitForDeployment();

    const token = await deployToken("Launch Token", "LAUNCH", owner);
    const wbnb = await deployToken("Wrapped BNB", "WBNB", owner);

    const Factory = await ethers.getContractFactory("MockTopazFeeFactory");
    const factory = await Factory.deploy(100);
    await factory.waitForDeployment();

    const Pool = await ethers.getContractFactory("MockTopazFeePool");
    const pool = await Pool.deploy(await factory.getAddress(), await token.getAddress(), await wbnb.getAddress(), false);
    await pool.waitForDeployment();
    await pool.mint(await locker.getAddress(), ethers.parseEther("1"));

    await locker.connect(owner).configureRevenue(await owner.getAddress(), await factory.getAddress());
    await expect(
      locker.connect(owner).registerGraduatedPool(
        await campaign.getAddress(),
        await creator.getAddress(),
        await feeRecipient.getAddress(),
        await pool.getAddress(),
        await token.getAddress(),
        await wbnb.getAddress(),
        ethers.parseEther("1")
      )
    ).to.be.revertedWithCustomError(locker, "InvalidTradingFee");
  });
});
