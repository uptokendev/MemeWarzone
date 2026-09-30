import { expect } from "chai";
import { ethers } from "hardhat";

function sorted(a: string, b: string) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

describe("MockTopazFactory and MockTopazPool", function () {
  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("MockTopazFactory");
    const factory = await Factory.deploy();
    await factory.waitForDeployment();

    const Pool = await ethers.getContractFactory("MockTopazPool");
    const pool = await Pool.deploy();
    await pool.waitForDeployment();

    const Pair = await ethers.getContractFactory("MockV2Pair");
    const pair = await Pair.deploy();
    await pair.waitForDeployment();

    return { owner, alice, bob, factory, pool, pair };
  }

  it("setPool stores sorted tokens and stable flag for either order", async () => {
    const { alice, bob, factory, pool } = await deployFixture();
    const tokenA = await alice.getAddress();
    const tokenB = await bob.getAddress();
    const [token0, token1] = sorted(tokenA, tokenB);

    await factory.setPool(tokenB, tokenA, true, await pool.getAddress());

    expect(await factory.getPool(tokenA, tokenB, true)).to.eq(await pool.getAddress());
    expect(await factory.getPool(tokenB, tokenA, true)).to.eq(await pool.getAddress());
    expect(await pool.token0()).to.eq(token0);
    expect(await pool.token1()).to.eq(token1);
    expect(await pool.stable()).to.eq(true);
  });

  it("setPair stores only the volatile pool slot", async () => {
    const { alice, bob, factory, pair } = await deployFixture();
    const tokenA = await alice.getAddress();
    const tokenB = await bob.getAddress();

    await factory.setPair(tokenA, tokenB, await pair.getAddress());

    expect(await factory.getPair(tokenA, tokenB)).to.eq(await pair.getAddress());
    expect(await factory.getPool(tokenA, tokenB, false)).to.eq(await pair.getAddress());
    expect(await factory.getPool(tokenA, tokenB, true)).to.eq(ethers.ZeroAddress);
  });

  it("createPool separates stable and volatile pools", async () => {
    const { alice, bob, factory } = await deployFixture();
    const tokenA = await alice.getAddress();
    const tokenB = await bob.getAddress();

    await factory.createPool(tokenA, tokenB, false);
    await factory.createPool(tokenA, tokenB, true);

    const volatilePool = await factory.getPool(tokenB, tokenA, false);
    const stablePool = await factory.getPool(tokenB, tokenA, true);
    expect(volatilePool).to.not.eq(ethers.ZeroAddress);
    expect(stablePool).to.not.eq(ethers.ZeroAddress);
    expect(volatilePool).to.not.eq(stablePool);
  });

  it("createPair is the same as a volatile createPool", async () => {
    const { alice, bob, factory } = await deployFixture();
    const tokenA = await alice.getAddress();
    const tokenB = await bob.getAddress();

    await factory.createPair(tokenA, tokenB);
    const pair = await factory.getPair(tokenA, tokenB);
    await factory.createPool(tokenB, tokenA, false);

    expect(pair).to.not.eq(ethers.ZeroAddress);
    expect(await factory.getPool(tokenB, tokenA, false)).to.eq(pair);
  });

  it("MockTopazPool exposes ERC20 metadata for LP balances", async () => {
    const { pool } = await deployFixture();

    expect(await pool.name()).to.eq("Mock Topaz LP");
    expect(await pool.symbol()).to.eq("mTLP");
    expect(await pool.decimals()).to.eq(18n);
  });

  it("MockTopazPool setTotalSupply mints and burns caller LP balances", async () => {
    const { owner, pool } = await deployFixture();

    await pool.connect(owner).setTotalSupply(100n);
    expect(await pool.totalSupply()).to.eq(100n);
    expect(await pool.balanceOf(await owner.getAddress())).to.eq(100n);

    await pool.connect(owner).setTotalSupply(25n);
    expect(await pool.totalSupply()).to.eq(25n);
    expect(await pool.balanceOf(await owner.getAddress())).to.eq(25n);
  });

  it("MockTopazPool mint and reserves can be updated independently", async () => {
    const { alice, pool } = await deployFixture();

    await pool["mint(address,uint256)"](await alice.getAddress(), 77n);
    await pool.setReserves(11n, 22n);
    const reserves = await pool.getReserves();

    expect(await pool.balanceOf(await alice.getAddress())).to.eq(77n);
    expect(await pool.totalSupply()).to.eq(77n);
    expect(reserves[0]).to.eq(11n);
    expect(reserves[1]).to.eq(22n);
    expect(reserves[2]).to.be.gt(0n);
  });
});
