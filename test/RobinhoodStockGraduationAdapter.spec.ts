import { expect } from "chai";
import { ethers } from "hardhat";

const FEE = 3000;

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function deployFreshFeed(price: string) {
  const Feed = await ethers.getContractFactory("MockUsdPriceFeed");
  const feed = await Feed.deploy(8);
  await feed.waitForDeployment();
  const now = await latestTimestamp();
  await feed.setRoundData(1n, ethers.parseUnits(price, 8), now, now, 1n);
  return feed;
}

async function deployFixture() {
  const [owner, other] = await ethers.getSigners();

  const WETH = await ethers.getContractFactory("MockWETH9");
  const weth = await WETH.deploy();
  await weth.waitForDeployment();

  const Factory = await ethers.getContractFactory("MockUniswapV3Factory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();

  const PositionManager = await ethers.getContractFactory("MockUniswapV3PositionManager");
  const positionManager = await PositionManager.deploy(await factory.getAddress(), await weth.getAddress());
  await positionManager.waitForDeployment();

  const Router = await ethers.getContractFactory("MockUniswapV3SwapRouter");
  const swapRouter = await Router.deploy(await factory.getAddress(), await weth.getAddress());
  await swapRouter.waitForDeployment();
  await factory.configurePeriphery(await positionManager.getAddress(), await swapRouter.getAddress());

  const Locker = await ethers.getContractFactory("PermanentV3PositionLocker");
  const locker = await Locker.deploy(await owner.getAddress());
  await locker.waitForDeployment();

  const nativeOracle = await deployFreshFeed("2000");
  const stockOracle = await deployFreshFeed("100");

  const Adapter = await ethers.getContractFactory("RobinhoodStockTokenGraduationAdapter");
  const adapter = await Adapter.deploy(
    await factory.getAddress(),
    await positionManager.getAddress(),
    await swapRouter.getAddress(),
    await weth.getAddress(),
    await locker.getAddress(),
    await nativeOracle.getAddress(),
    FEE,
    900,
  );
  await adapter.waitForDeployment();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const stock = await MockERC20.deploy("NVIDIA Stock Token", "NVDA", ethers.parseUnits("1000000", 18), await owner.getAddress());
  await stock.waitForDeployment();
  const meme = await MockERC20.deploy("Battle Meme", "BMEME", ethers.parseEther("1000000"), await owner.getAddress());
  await meme.waitForDeployment();

  await factory.createPool(await weth.getAddress(), await stock.getAddress(), FEE);
  const acquisitionPool = await factory.getPool(await weth.getAddress(), await stock.getAddress(), FEE);

  const CampaignFactory = await ethers.getContractFactory("MockRobinhoodStockCampaignFactory");
  const campaignFactory = await CampaignFactory.deploy();
  await campaignFactory.waitForDeployment();

  const CampaignHarness = await ethers.getContractFactory("MockRobinhoodStockCampaignHarness");
  const campaignHarness = await CampaignHarness.deploy();
  await campaignHarness.waitForDeployment();

  return {
    owner,
    other,
    weth,
    factory,
    positionManager,
    swapRouter,
    locker,
    nativeOracle,
    stockOracle,
    adapter,
    stock,
    meme,
    acquisitionPool,
    campaignFactory,
    campaignHarness,
  };
}

function routeConfig(fx: Awaited<ReturnType<typeof deployFixture>>) {
  return {
    oracleFeed: fx.stockOracle.getAddress(),
    acquisitionPool: fx.acquisitionPool,
    acquisitionFeeTier: FEE,
    minimumRouteLiquidityUsdWad: ethers.parseEther("1"),
    maxSwapSlippageBps: 300,
    maxOracleDeviationBps: 500,
    maxPriceImpactBps: 500,
    enabled: true,
  };
}

describe("Robinhood Stock Token graduation adapter", function () {
  it("locks the MemeWarzone campaign factory exactly once", async () => {
    const fx = await deployFixture();
    await expect(fx.adapter.setCampaignFactoryOnce(await fx.campaignFactory.getAddress()))
      .to.emit(fx.adapter, "CampaignFactoryLocked");
    expect(await fx.adapter.campaignFactoryLocked()).to.equal(true);
    await expect(fx.adapter.setCampaignFactoryOnce(await fx.campaignFactory.getAddress()))
      .to.be.revertedWithCustomError(fx.adapter, "FactoryAlreadyLocked");
  });

  it("only accepts an acquisition pool resolved by the canonical V3 factory", async () => {
    const fx = await deployFixture();
    const badRoute = {
      ...(await routeConfig(fx)),
      acquisitionPool: await fx.other.getAddress(),
    };
    await expect(fx.adapter.configureStockRoute(await fx.stock.getAddress(), badRoute))
      .to.be.revertedWithCustomError(fx.adapter, "ContractCodeMissing");

    const correct = await routeConfig(fx);
    await expect(fx.adapter.configureStockRoute(await fx.stock.getAddress(), correct))
      .to.emit(fx.adapter, "StockRouteConfigured");
    const stored = await fx.adapter.stockRoutes(await fx.stock.getAddress());
    expect(stored.acquisitionPool).to.equal(fx.acquisitionPool);
    expect(stored.enabled).to.equal(true);
  });

  it("rejects direct callers even when a Stock route is approved", async () => {
    const fx = await deployFixture();
    await fx.adapter.setCampaignFactoryOnce(await fx.campaignFactory.getAddress());
    await fx.adapter.configureStockRoute(await fx.stock.getAddress(), await routeConfig(fx));

    await expect(
      fx.adapter.connect(fx.other).graduateStockLiquidity({
        campaignToken: await fx.meme.getAddress(),
        stockToken: await fx.stock.getAddress(),
        memeAmountDesired: ethers.parseEther("100"),
        minimumMemeUsed: ethers.parseEther("90"),
        minimumStockOut: 1n,
        finalCurvePriceNativeWad: ethers.parseEther("0.001"),
        deadline: (await latestTimestamp()) + 60n,
      }, { value: ethers.parseEther("1") })
    ).to.be.revertedWithCustomError(fx.adapter, "UnauthorizedCampaign");
  });

  it("fails closed when the selected Stock route is disabled", async () => {
    const fx = await deployFixture();
    await fx.adapter.setCampaignFactoryOnce(await fx.campaignFactory.getAddress());
    await fx.campaignFactory.setCampaign(await fx.campaignHarness.getAddress(), true);
    const disabled = { ...(await routeConfig(fx)), enabled: false };
    await fx.adapter.configureStockRoute(await fx.stock.getAddress(), disabled);

    await fx.meme.transfer(await fx.campaignHarness.getAddress(), ethers.parseEther("100"));
    await expect(
      fx.campaignHarness.execute(await fx.adapter.getAddress(), {
        campaignToken: await fx.meme.getAddress(),
        stockToken: await fx.stock.getAddress(),
        memeAmountDesired: ethers.parseEther("100"),
        minimumMemeUsed: ethers.parseEther("90"),
        minimumStockOut: 1n,
        finalCurvePriceNativeWad: ethers.parseEther("0.001"),
        deadline: (await latestTimestamp()) + 60n,
      }, { value: ethers.parseEther("1") })
    ).to.be.revertedWithCustomError(fx.adapter, "RouteDisabled");
  });
});
