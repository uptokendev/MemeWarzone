import { expect } from "chai";
import { ethers } from "hardhat";

const FEE = 3000;
const Q96 = 1n << 96n;

async function deployFixture() {
  const [owner, trader] = await ethers.getSigners();

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

  const Token = await ethers.getContractFactory("MockERC20");
  const token = await Token.deploy("Robinhood Test Meme", "RHM", ethers.parseEther("1000000"), await owner.getAddress());
  await token.waitForDeployment();

  const tokenAddress = await token.getAddress();
  const wethAddress = await weth.getAddress();
  const tokenFirst = tokenAddress.toLowerCase() < wethAddress.toLowerCase();
  const token0 = tokenFirst ? tokenAddress : wethAddress;
  const token1 = tokenFirst ? wethAddress : tokenAddress;

  await positionManager.createAndInitializePoolIfNecessary(token0, token1, FEE, Q96);
  const tokenLiquidity = ethers.parseEther("1000");
  const wethLiquidity = ethers.parseEther("10");
  await weth.deposit({ value: wethLiquidity });
  await token.approve(await positionManager.getAddress(), tokenLiquidity);
  await weth.approve(await positionManager.getAddress(), wethLiquidity);

  const block = await ethers.provider.getBlock("latest");
  await positionManager.mint({
    token0,
    token1,
    fee: FEE,
    tickLower: -887220,
    tickUpper: 887220,
    amount0Desired: tokenFirst ? tokenLiquidity : wethLiquidity,
    amount1Desired: tokenFirst ? wethLiquidity : tokenLiquidity,
    amount0Min: tokenFirst ? tokenLiquidity : wethLiquidity,
    amount1Min: tokenFirst ? wethLiquidity : tokenLiquidity,
    recipient: await owner.getAddress(),
    deadline: BigInt(block!.timestamp + 600),
  });

  const Adapter = await ethers.getContractFactory("RobinhoodV3NativeSwapAdapter");
  const adapter = await Adapter.deploy(await swapRouter.getAddress(), wethAddress);
  await adapter.waitForDeployment();

  return { owner, trader, weth, factory, positionManager, swapRouter, token, adapter };
}

// Any far-future timestamp: these tests are about swap mechanics, not expiry.
const FAR_FUTURE = 4_000_000_000n;

describe("RobinhoodV3NativeSwapAdapter", function () {
  it("buys a Robinhood V3 token with native ETH in one swap call", async () => {
    const { trader, swapRouter, token, weth, adapter } = await deployFixture();
    const nativeIn = ethers.parseEther("1");
    const quoted = await swapRouter.quoteExactInputSingle(
      await weth.getAddress(),
      await token.getAddress(),
      FEE,
      nativeIn,
    );

    await expect(
      adapter.connect(trader).buyExactNativeIn(
        await token.getAddress(),
        FEE,
        quoted,
        await trader.getAddress(),
        FAR_FUTURE,
        { value: nativeIn },
      ),
    ).to.emit(adapter, "NativeBuy");

    expect(await token.balanceOf(await trader.getAddress())).to.equal(quoted);
    expect(await weth.balanceOf(await adapter.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await adapter.getAddress())).to.equal(0n);
  });

  it("sells a Robinhood V3 token back to native ETH without leaving wrapped/native dust", async () => {
    const { trader, swapRouter, token, weth, adapter } = await deployFixture();
    const nativeIn = ethers.parseEther("1");
    const tokenOut = await swapRouter.quoteExactInputSingle(
      await weth.getAddress(),
      await token.getAddress(),
      FEE,
      nativeIn,
    );

    await adapter.connect(trader).buyExactNativeIn(
      await token.getAddress(),
      FEE,
      1n,
      await trader.getAddress(),
      FAR_FUTURE,
      { value: nativeIn },
    );

    await token.connect(trader).approve(await adapter.getAddress(), tokenOut);
    const nativeOut = await swapRouter.quoteExactInputSingle(
      await token.getAddress(),
      await weth.getAddress(),
      FEE,
      tokenOut,
    );

    await expect(
      adapter.connect(trader).sellExactTokenIn(
        await token.getAddress(),
        FEE,
        tokenOut,
        nativeOut,
        await trader.getAddress(),
        FAR_FUTURE,
      ),
    ).to.emit(adapter, "NativeSell");

    expect(await token.balanceOf(await adapter.getAddress())).to.equal(0n);
    expect(await weth.balanceOf(await adapter.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await adapter.getAddress())).to.equal(0n);
  });

  it("rejects invalid token/native configuration", async () => {
    const { trader, weth, adapter } = await deployFixture();
    await expect(
      adapter.connect(trader).buyExactNativeIn(
        await weth.getAddress(),
        FEE,
        1n,
        await trader.getAddress(),
        FAR_FUTURE,
        { value: 1n },
      ),
    ).to.be.revertedWith("invalid token");
  });

  it("refuses an expired swap and one with no slippage bound at all", async () => {
    // Slippage bounds the price a trader accepts; the deadline bounds when they
    // accept it, so a transaction left in the mempool cannot land much later
    // against a book that has moved. The multi-hop adapter has always enforced
    // both; this one enforced neither.
    const { trader, token, adapter } = await deployFixture();
    const past = BigInt((await ethers.provider.getBlock("latest"))!.timestamp - 1);

    await expect(
      adapter.connect(trader).buyExactNativeIn(
        await token.getAddress(),
        FEE,
        1n,
        await trader.getAddress(),
        past,
        { value: ethers.parseEther("1") },
      ),
    ).to.be.revertedWith("deadline");

    await expect(
      adapter.connect(trader).buyExactNativeIn(
        await token.getAddress(),
        FEE,
        0n,
        await trader.getAddress(),
        FAR_FUTURE,
        { value: ethers.parseEther("1") },
      ),
    ).to.be.revertedWith("zero minimum out");

    await expect(
      adapter.connect(trader).sellExactTokenIn(
        await token.getAddress(),
        FEE,
        1n,
        0n,
        await trader.getAddress(),
        FAR_FUTURE,
      ),
    ).to.be.revertedWith("zero minimum out");
  });
});
