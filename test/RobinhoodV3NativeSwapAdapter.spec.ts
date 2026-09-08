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
        0n,
        await trader.getAddress(),
        { value: 1n },
      ),
    ).to.be.revertedWith("invalid token");
  });
});
