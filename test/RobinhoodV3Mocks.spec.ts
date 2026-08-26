import { expect } from "chai";
import { ethers } from "hardhat";

const FEE = 3000;
const Q96 = 1n << 96n;
const MAX_UINT128 = (1n << 128n) - 1n;

async function deployMockV3() {
  const WETH = await ethers.getContractFactory("MockWETH9");
  const weth = await WETH.deploy();
  await weth.waitForDeployment();

  const Factory = await ethers.getContractFactory("MockUniswapV3Factory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();

  const PositionManager = await ethers.getContractFactory("MockUniswapV3PositionManager");
  const positionManager = await PositionManager.deploy(await factory.getAddress(), await weth.getAddress());
  await positionManager.waitForDeployment();

  const SwapRouter = await ethers.getContractFactory("MockUniswapV3SwapRouter");
  const swapRouter = await SwapRouter.deploy(await factory.getAddress(), await weth.getAddress());
  await swapRouter.waitForDeployment();

  await factory.configurePeriphery(await positionManager.getAddress(), await swapRouter.getAddress());
  return { weth, factory, positionManager, swapRouter };
}

describe("Robinhood Uniswap V3 minimal staging DEX", function () {
  it("creates one V3-style pool, mints an NFT position, swaps and accrues collectible fees", async () => {
    const [owner, trader] = await ethers.getSigners();
    const { weth, factory, positionManager, swapRouter } = await deployMockV3();

    const Token = await ethers.getContractFactory("MockERC20");
    const token = await Token.deploy("Robinhood Test Meme", "RHM", ethers.parseEther("1000000"), await owner.getAddress());
    await token.waitForDeployment();

    const tokenAddress = await token.getAddress();
    const wethAddress = await weth.getAddress();
    const tokenFirst = tokenAddress.toLowerCase() < wethAddress.toLowerCase();
    const token0 = tokenFirst ? tokenAddress : wethAddress;
    const token1 = tokenFirst ? wethAddress : tokenAddress;

    await positionManager.createAndInitializePoolIfNecessary(token0, token1, FEE, Q96);
    const poolAddress = await factory.getPool(tokenAddress, wethAddress, FEE);
    expect(poolAddress).to.not.equal(ethers.ZeroAddress);
    expect(await factory.getPool(wethAddress, tokenAddress, FEE)).to.equal(poolAddress);

    const pool = await ethers.getContractAt("MockUniswapV3Pool", poolAddress);
    expect(await pool.sqrtPriceX96()).to.equal(Q96);
    expect(await pool.fee()).to.equal(BigInt(FEE));
    expect(await pool.tickSpacing()).to.equal(60n);

    const tokenLiquidity = ethers.parseEther("1000");
    const wethLiquidity = ethers.parseEther("10");
    await weth.deposit({ value: wethLiquidity });
    await token.approve(await positionManager.getAddress(), tokenLiquidity);
    await weth.approve(await positionManager.getAddress(), wethLiquidity);

    const amount0Desired = tokenFirst ? tokenLiquidity : wethLiquidity;
    const amount1Desired = tokenFirst ? wethLiquidity : tokenLiquidity;
    const block = await ethers.provider.getBlock("latest");
    await positionManager.mint({
      token0,
      token1,
      fee: FEE,
      tickLower: -887220,
      tickUpper: 887220,
      amount0Desired,
      amount1Desired,
      amount0Min: amount0Desired,
      amount1Min: amount1Desired,
      recipient: await owner.getAddress(),
      deadline: BigInt(block!.timestamp + 600),
    });

    expect(await positionManager.ownerOf(1n)).to.equal(await owner.getAddress());
    expect(await pool.positionTokenId()).to.equal(1n);
    expect(await pool.reserve0()).to.equal(amount0Desired);
    expect(await pool.reserve1()).to.equal(amount1Desired);

    const swapIn = ethers.parseEther("1");
    await weth.connect(trader).deposit({ value: swapIn });
    await weth.connect(trader).approve(await swapRouter.getAddress(), swapIn);
    const quoted = await swapRouter.quoteExactInputSingle(wethAddress, tokenAddress, FEE, swapIn);
    expect(quoted).to.be.greaterThan(0n);

    await swapRouter.connect(trader).exactInputSingle({
      tokenIn: wethAddress,
      tokenOut: tokenAddress,
      fee: FEE,
      recipient: await trader.getAddress(),
      amountIn: swapIn,
      amountOutMinimum: quoted,
      sqrtPriceLimitX96: 0,
    });
    expect(await token.balanceOf(await trader.getAddress())).to.equal(quoted);

    const expectedFee = (swapIn * BigInt(FEE)) / 1_000_000n;
    const wethIs0 = wethAddress.toLowerCase() === token0.toLowerCase();
    expect(wethIs0 ? await pool.claimable0() : await pool.claimable1()).to.equal(expectedFee);

    const ownerWethBefore = await weth.balanceOf(await owner.getAddress());
    await positionManager.collect({
      tokenId: 1n,
      recipient: await owner.getAddress(),
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    });
    expect((await weth.balanceOf(await owner.getAddress())) - ownerWethBefore).to.equal(expectedFee);
    expect(await pool.claimable0()).to.equal(0n);
    expect(await pool.claimable1()).to.equal(0n);

    await expect(
      positionManager.connect(trader).transferFrom(await owner.getAddress(), await trader.getAddress(), 1n)
    ).to.be.reverted;
  });

  it("fails closed on disabled fee tiers and one-time periphery wiring", async () => {
    const [owner, tokenA, tokenB] = await ethers.getSigners();
    const { factory, positionManager, swapRouter } = await deployMockV3();

    await expect(factory.createPool(await tokenA.getAddress(), await tokenB.getAddress(), 1234)).to.be.revertedWith("fee disabled");
    await expect(
      factory.configurePeriphery(await positionManager.getAddress(), await swapRouter.getAddress())
    ).to.be.revertedWith("periphery already set");
    expect(await factory.owner()).to.equal(await owner.getAddress());
  });
});
