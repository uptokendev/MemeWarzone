import { expect } from "chai";
import { ethers } from "hardhat";

const FEE = 3000;
const Q96 = 1n << 96n;
const MAX_IMPACT_BPS = 10_000;

async function nowTs() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function seedPool(
  owner: any,
  factory: any,
  positionManager: any,
  tokenA: any,
  tokenB: any,
  amountA: bigint,
  amountB: bigint,
) {
  const tokenAAddress = await tokenA.getAddress();
  const tokenBAddress = await tokenB.getAddress();
  const token0 = tokenAAddress.toLowerCase() < tokenBAddress.toLowerCase() ? tokenAAddress : tokenBAddress;
  const token1 = token0 === tokenAAddress ? tokenBAddress : tokenAAddress;

  await positionManager.createAndInitializePoolIfNecessary(token0, token1, FEE, Q96);
  await tokenA.connect(owner).approve(await positionManager.getAddress(), amountA);
  await tokenB.connect(owner).approve(await positionManager.getAddress(), amountB);

  await positionManager.connect(owner).mint({
    token0,
    token1,
    fee: FEE,
    tickLower: -887220,
    tickUpper: 887220,
    amount0Desired: token0 === tokenAAddress ? amountA : amountB,
    amount1Desired: token0 === tokenAAddress ? amountB : amountA,
    amount0Min: token0 === tokenAAddress ? amountA : amountB,
    amount1Min: token0 === tokenAAddress ? amountB : amountA,
    recipient: await owner.getAddress(),
    deadline: (await nowTs()) + 3600n,
  });

  return factory.getPool(tokenAAddress, tokenBAddress, FEE);
}

async function fixture() {
  const [owner, trader, recipient, outsider] = await ethers.getSigners();

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
  const stock = await Token.deploy(
    "NVIDIA Stock Token",
    "NVDA",
    ethers.parseEther("1000000"),
    await owner.getAddress(),
  );
  await stock.waitForDeployment();
  const meme = await Token.deploy(
    "NVIDIA War Meme",
    "NVWAR",
    ethers.parseEther("10000000"),
    await owner.getAddress(),
  );
  await meme.waitForDeployment();

  const wethLiquidity = ethers.parseEther("100");
  await weth.connect(owner).deposit({ value: wethLiquidity });

  const nativeStockPool = await seedPool(
    owner,
    factory,
    positionManager,
    weth,
    stock,
    wethLiquidity,
    ethers.parseEther("3000"),
  );
  const stockMemePool = await seedPool(
    owner,
    factory,
    positionManager,
    stock,
    meme,
    ethers.parseEther("3000"),
    ethers.parseEther("300000"),
  );

  const Adapter = await ethers.getContractFactory("RobinhoodV3MultiHopSwapAdapter");
  const adapter = await Adapter.deploy(
    await factory.getAddress(),
    await swapRouter.getAddress(),
    await weth.getAddress(),
  );
  await adapter.waitForDeployment();

  await adapter.configureMarketRoute(
    await meme.getAddress(),
    await stock.getAddress(),
    FEE,
    FEE,
    MAX_IMPACT_BPS,
    true,
  );

  return {
    owner,
    trader,
    recipient,
    outsider,
    weth,
    factory,
    positionManager,
    swapRouter,
    stock,
    meme,
    nativeStockPool,
    stockMemePool,
    adapter,
  };
}

function assertPositiveQuote(quote: any) {
  expect(quote.intermediateOut).to.be.greaterThan(0n);
  expect(quote.finalOut).to.be.greaterThan(0n);
  expect(quote.quotedAt).to.be.greaterThan(0n);
}

describe("RobinhoodV3MultiHopSwapAdapter", function () {
  it("locks a MEME token to one configured Stock route and exposes route health", async () => {
    const fx = await fixture();
    const health = await fx.adapter.routeHealth(await fx.meme.getAddress());

    expect(health.configured).to.equal(true);
    expect(health.enabled).to.equal(true);
    expect(health.stockToken).to.equal(await fx.stock.getAddress());
    expect(health.nativeStockPool).to.equal(fx.nativeStockPool);
    expect(health.stockMemePool).to.equal(fx.stockMemePool);
    expect(health.poolsValid).to.equal(true);

    await expect(
      fx.adapter.connect(fx.outsider).configureMarketRoute(
        await fx.meme.getAddress(),
        await fx.stock.getAddress(),
        FEE,
        FEE,
        MAX_IMPACT_BPS,
        true,
      ),
    ).to.be.revertedWithCustomError(fx.adapter, "OnlyAdmin");
  });

  it("quotes both Stock Battlefield directions without exposing Stock to the trader", async () => {
    const fx = await fixture();
    const buyQuote = await fx.adapter.quoteBuyWithNative(await fx.meme.getAddress(), ethers.parseEther("1"));
    assertPositiveQuote(buyQuote);
    expect(buyQuote.stockToken).to.equal(await fx.stock.getAddress());

    const sellQuote = await fx.adapter.quoteSellForNative(
      await fx.meme.getAddress(),
      ethers.parseEther("100"),
    );
    assertPositiveQuote(sellQuote);
    expect(sellQuote.stockToken).to.equal(await fx.stock.getAddress());
  });

  it("atomically buys MEME with ETH through WETH -> Stock -> MEME and leaves no intermediate residue", async () => {
    const fx = await fixture();
    const nativeIn = ethers.parseEther("1");
    const quote = await fx.adapter.quoteBuyWithNative(await fx.meme.getAddress(), nativeIn);
    const minimumStockOut = (quote.intermediateOut * 99n) / 100n;
    const minimumMemeOut = (quote.finalOut * 99n) / 100n;
    const traderStockBefore = await fx.stock.balanceOf(await fx.trader.getAddress());
    const traderMemeBefore = await fx.meme.balanceOf(await fx.trader.getAddress());

    await expect(
      fx.adapter.connect(fx.trader).buyWithNative(
        await fx.meme.getAddress(),
        minimumStockOut,
        minimumMemeOut,
        (await nowTs()) + 3600n,
        await fx.trader.getAddress(),
        { value: nativeIn },
      ),
    ).to.emit(fx.adapter, "StockRouteNativeBuy");

    expect(await fx.stock.balanceOf(await fx.trader.getAddress())).to.equal(traderStockBefore);
    expect(await fx.meme.balanceOf(await fx.trader.getAddress())).to.be.greaterThan(traderMemeBefore);
    expect(await fx.weth.balanceOf(await fx.adapter.getAddress())).to.equal(0n);
    expect(await fx.stock.balanceOf(await fx.adapter.getAddress())).to.equal(0n);
    expect(await fx.meme.balanceOf(await fx.adapter.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await fx.adapter.getAddress())).to.equal(0n);
  });

  it("atomically sells MEME through Stock -> WETH -> ETH without requiring a Stock allowance", async () => {
    const fx = await fixture();
    const nativeIn = ethers.parseEther("1");
    const buyQuote = await fx.adapter.quoteBuyWithNative(await fx.meme.getAddress(), nativeIn);
    await fx.adapter.connect(fx.trader).buyWithNative(
      await fx.meme.getAddress(),
      (buyQuote.intermediateOut * 99n) / 100n,
      (buyQuote.finalOut * 99n) / 100n,
      (await nowTs()) + 3600n,
      await fx.trader.getAddress(),
      { value: nativeIn },
    );

    const memeIn = (await fx.meme.balanceOf(await fx.trader.getAddress())) / 2n;
    const sellQuote = await fx.adapter.quoteSellForNative(await fx.meme.getAddress(), memeIn);
    await fx.meme.connect(fx.trader).approve(await fx.adapter.getAddress(), memeIn);
    const recipientBefore = await ethers.provider.getBalance(await fx.recipient.getAddress());
    const traderStockBefore = await fx.stock.balanceOf(await fx.trader.getAddress());

    await expect(
      fx.adapter.connect(fx.trader).sellForNative(
        await fx.meme.getAddress(),
        memeIn,
        (sellQuote.intermediateOut * 99n) / 100n,
        (sellQuote.finalOut * 99n) / 100n,
        (await nowTs()) + 3600n,
        await fx.recipient.getAddress(),
      ),
    ).to.emit(fx.adapter, "StockRouteNativeSell");

    const recipientAfter = await ethers.provider.getBalance(await fx.recipient.getAddress());
    expect(recipientAfter - recipientBefore).to.equal(sellQuote.finalOut);
    expect(await fx.stock.balanceOf(await fx.trader.getAddress())).to.equal(traderStockBefore);
    expect(await fx.stock.allowance(await fx.trader.getAddress(), await fx.adapter.getAddress())).to.equal(0n);
    expect(await fx.weth.balanceOf(await fx.adapter.getAddress())).to.equal(0n);
    expect(await fx.stock.balanceOf(await fx.adapter.getAddress())).to.equal(0n);
    expect(await fx.meme.balanceOf(await fx.adapter.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await fx.adapter.getAddress())).to.equal(0n);
  });

  it("fails closed for disabled or non-canonical routes", async () => {
    const fx = await fixture();
    await fx.adapter.configureMarketRoute(
      await fx.meme.getAddress(),
      await fx.stock.getAddress(),
      FEE,
      FEE,
      MAX_IMPACT_BPS,
      false,
    );

    await expect(
      fx.adapter.quoteBuyWithNative(await fx.meme.getAddress(), ethers.parseEther("1")),
    ).to.be.revertedWithCustomError(fx.adapter, "RouteDisabled");

    const Token = await ethers.getContractFactory("MockERC20");
    const unrelated = await Token.deploy(
      "Unrelated Meme",
      "NOPOOL",
      ethers.parseEther("1000"),
      await fx.owner.getAddress(),
    );
    await unrelated.waitForDeployment();

    await expect(
      fx.adapter.configureMarketRoute(
        await unrelated.getAddress(),
        await fx.stock.getAddress(),
        FEE,
        FEE,
        MAX_IMPACT_BPS,
        true,
      ),
    ).to.be.revertedWithCustomError(fx.adapter, "RoutePoolUnavailable");
  });

  it("enforces deadline and both intermediate/final minimum outputs before moving funds", async () => {
    const fx = await fixture();
    const nativeIn = ethers.parseEther("1");
    const quote = await fx.adapter.quoteBuyWithNative(await fx.meme.getAddress(), nativeIn);

    await expect(
      fx.adapter.connect(fx.trader).buyWithNative(
        await fx.meme.getAddress(),
        1n,
        1n,
        (await nowTs()) - 1n,
        await fx.trader.getAddress(),
        { value: nativeIn },
      ),
    ).to.be.revertedWithCustomError(fx.adapter, "DeadlineExpired");

    await expect(
      fx.adapter.connect(fx.trader).buyWithNative(
        await fx.meme.getAddress(),
        quote.intermediateOut + 1n,
        1n,
        (await nowTs()) + 3600n,
        await fx.trader.getAddress(),
        { value: nativeIn },
      ),
    ).to.be.revertedWithCustomError(fx.adapter, "MinimumOutputUnreachable");

    await expect(
      fx.adapter.connect(fx.trader).buyWithNative(
        await fx.meme.getAddress(),
        1n,
        quote.finalOut + 1n,
        (await nowTs()) + 3600n,
        await fx.trader.getAddress(),
        { value: nativeIn },
      ),
    ).to.be.revertedWithCustomError(fx.adapter, "MinimumOutputUnreachable");

    expect(await fx.weth.balanceOf(await fx.adapter.getAddress())).to.equal(0n);
    expect(await fx.stock.balanceOf(await fx.adapter.getAddress())).to.equal(0n);
    expect(await fx.meme.balanceOf(await fx.adapter.getAddress())).to.equal(0n);
  });

  it("rejects a route quote when either hop exceeds the configured price-impact policy", async () => {
    const fx = await fixture();
    await fx.adapter.configureMarketRoute(
      await fx.meme.getAddress(),
      await fx.stock.getAddress(),
      FEE,
      FEE,
      10,
      true,
    );

    await expect(
      fx.adapter.quoteBuyWithNative(await fx.meme.getAddress(), ethers.parseEther("10")),
    ).to.be.revertedWithCustomError(fx.adapter, "PriceImpactTooHigh");
  });
});
