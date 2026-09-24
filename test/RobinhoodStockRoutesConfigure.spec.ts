import { expect } from "chai";
import { ethers } from "hardhat";
import { ADAPTER_ABI, bindFactoryIfMissing, configureRoutes } from "../scripts/configure-robinhood-stock-routes";

const FEE = 3000;
const POLICY = { minimumRouteLiquidityUsd: "50000", maxSwapSlippageBps: 300, maxOracleDeviationBps: 500, maxPriceImpactBps: 500 };

async function now() { return (await ethers.provider.getBlock("latest"))!.timestamp; }
async function feedAt(price: string, updatedAt: number) {
  const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8); await feed.waitForDeployment();
  await (await (feed as any).setRoundData(1n, ethers.parseUnits(price, 8), updatedAt, updatedAt, 1n)).wait();
  return feed;
}

async function fixture() {
  const [owner, other] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy(); await weth.waitForDeployment();
  const v3 = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy(); await v3.waitForDeployment();
  const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManager")).deploy(await v3.getAddress(), await weth.getAddress()); await npm.waitForDeployment();
  const router = await (await ethers.getContractFactory("MockUniswapV3SwapRouter")).deploy(await v3.getAddress(), await weth.getAddress()); await router.waitForDeployment();
  const locker = await (await ethers.getContractFactory("PermanentV3PositionLocker")).deploy(owner.address); await locker.waitForDeployment();
  const t = await now();
  const nativeOracle = await feedAt("2000", t);
  const adapterImpl = await (await ethers.getContractFactory("RobinhoodStockTokenGraduationAdapter")).deploy(
    await v3.getAddress(), await npm.getAddress(), await router.getAddress(), await weth.getAddress(), await locker.getAddress(), await nativeOracle.getAddress(), FEE, 900,
  );
  await adapterImpl.waitForDeployment();
  const adapter = new ethers.Contract(await adapterImpl.getAddress(), ADAPTER_ABI, owner);
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const mkStock = async (sym: string, wethDepth: string) => {
    const stock = await MockERC20.deploy(`${sym} Stock Token`, sym, ethers.parseUnits("1000000", 18), owner.address); await stock.waitForDeployment();
    await (await v3.createPool(await weth.getAddress(), await stock.getAddress(), FEE)).wait();
    const pool = await v3.getPool(await weth.getAddress(), await stock.getAddress(), FEE);
    await (await weth.deposit({ value: ethers.parseEther(wethDepth) })).wait();
    await (await weth.transfer(pool, ethers.parseEther(wethDepth))).wait();
    const feed = await feedAt("100", await now());
    return { symbol: sym, stockToken: await stock.getAddress(), oracleFeed: await feed.getAddress(), acquisitionPool: pool, acquisitionFeeTier: FEE, feed };
  };
  return { owner, other, weth, v3, adapter, mkStock, nativeOracle };
}

describe("Robinhood stock routes configuration", function () {
  it("binds the factory once (only when the factory names this adapter) and configures routes from re-derived facts", async function () {
    const f = await fixture();
    const good = await f.mkStock("AAPL", "30"); // 30 WETH * $2000 * 2 = $120k >= $50k floor
    const pointer = await (await ethers.getContractFactory("MockStockFactoryPointer")).deploy(await f.adapter.getAddress()); await pointer.waitForDeployment();
    const stranger = await (await ethers.getContractFactory("MockStockFactoryPointer")).deploy(f.other.address); await stranger.waitForDeployment();

    await expect(bindFactoryIfMissing(f.adapter, await stranger.getAddress(), true)).to.be.rejectedWith(/names .* as its stock adapter, not this one/);
    expect((await bindFactoryIfMissing(f.adapter, await pointer.getAddress(), false)).action).to.equal("would-bind");
    expect(await f.adapter.campaignFactoryLocked()).to.equal(false);
    expect((await bindFactoryIfMissing(f.adapter, await pointer.getAddress(), true)).action).to.equal("bound");
    expect(await f.adapter.campaignFactoryLocked()).to.equal(true);
    expect((await bindFactoryIfMissing(f.adapter, await pointer.getAddress(), true)).action).to.equal("already-bound");
    await expect(bindFactoryIfMissing(f.adapter, await stranger.getAddress(), true)).to.be.rejectedWith(/locked to/);

    const dry = await configureRoutes({ adapter: f.adapter, routes: [good], policy: POLICY, send: false, nowSeconds: await now() });
    expect(dry[0].action).to.equal("would-configure");
    expect((await f.adapter.stockRoutes(good.stockToken)).enabled).to.equal(false);

    const sent = await configureRoutes({ adapter: f.adapter, routes: [good], policy: POLICY, send: true, nowSeconds: await now() });
    expect(sent[0].action).to.equal("configured");
    const stored = await f.adapter.stockRoutes(good.stockToken);
    expect(stored.enabled).to.equal(true);
    expect(stored.acquisitionPool).to.equal(good.acquisitionPool);
    expect(stored.minimumRouteLiquidityUsdWad).to.equal(ethers.parseUnits("50000", 18));
    expect(Number(stored.maxPriceImpactBps)).to.equal(500);

    const again = await configureRoutes({ adapter: f.adapter, routes: [good], policy: POLICY, send: true, nowSeconds: await now() });
    expect(again[0].action).to.equal("unchanged");
  });

  it("refuses a thin pool, a stale feed and a non-canonical pool -- and configures nothing", async function () {
    const f = await fixture();
    const thin = await f.mkStock("DELL", "1"); // $4k
    await expect(configureRoutes({ adapter: f.adapter, routes: [thin], policy: POLICY, send: true, nowSeconds: await now() })).to.be.rejectedWith(/below the \$50000 floor/);

    const stale = await f.mkStock("GME", "30");
    const t = await now();
    await (await (stale.feed as any).setRoundData(2n, ethers.parseUnits("100", 8), t - 5000, t - 5000, 2n)).wait();
    await expect(configureRoutes({ adapter: f.adapter, routes: [stale], policy: POLICY, send: true, nowSeconds: t })).to.be.rejectedWith(/feed is \d+s old, adapter allows 900s/);

    const wrongPool = { ...(await f.mkStock("SPY", "30")), acquisitionPool: thin.acquisitionPool };
    await expect(configureRoutes({ adapter: f.adapter, routes: [wrongPool], policy: POLICY, send: true, nowSeconds: await now() })).to.be.rejectedWith(/not the canonical/);

    for (const r of [thin, stale, wrongPool]) expect((await f.adapter.stockRoutes(r.stockToken)).enabled).to.equal(false);
  });
});
