import { expect } from "chai";
import { ethers } from "hardhat";

describe("MockTopazPool ERC20 behavior", function () {
  async function deployPool() {
    const [owner, alice, bob, spender] = await ethers.getSigners();
    const Pool = await ethers.getContractFactory("MockTopazPool");
    const pool = await Pool.deploy();
    await pool.waitForDeployment();
    return { pool, owner, alice, bob, spender };
  }

  it("minted LP balances can be transferred", async () => {
    const { pool, alice, bob } = await deployPool();

    await pool["mint(address,uint256)"](await alice.getAddress(), 100n);
    await expect(pool.connect(alice).transfer(await bob.getAddress(), 40n))
      .to.emit(pool, "Transfer")
      .withArgs(await alice.getAddress(), await bob.getAddress(), 40n);

    expect(await pool.balanceOf(await alice.getAddress())).to.eq(60n);
    expect(await pool.balanceOf(await bob.getAddress())).to.eq(40n);
    expect(await pool.totalSupply()).to.eq(100n);
  });

  it("minted LP balances support approvals and transferFrom", async () => {
    const { pool, alice, bob, spender } = await deployPool();

    await pool["mint(address,uint256)"](await alice.getAddress(), 100n);
    await pool.connect(alice).approve(await spender.getAddress(), 25n);
    await pool.connect(spender).transferFrom(await alice.getAddress(), await bob.getAddress(), 25n);

    expect(await pool.allowance(await alice.getAddress(), await spender.getAddress())).to.eq(0n);
    expect(await pool.balanceOf(await bob.getAddress())).to.eq(25n);
  });

  it("setTotalSupply burn path reverts if the caller lacks enough LP", async () => {
    const { pool, owner, alice } = await deployPool();

    await pool.connect(owner).setTotalSupply(100n);
    await expect(pool.connect(alice).setTotalSupply(50n)).to.be.reverted;
    expect(await pool.totalSupply()).to.eq(100n);
  });
});
