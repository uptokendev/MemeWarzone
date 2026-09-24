import { expect } from "chai";
import { ethers } from "hardhat";
import { ADAPTER_ABI, configureRoutes, requireFactoryBound } from "../scripts/configure-bnb-quote-routes";

const POLICY = { minimumRouteLiquidityUsd: "50000", maxSwapSlippageBps: 300, maxOracleDeviationBps: 500, maxPriceImpactBps: 500, maxGraduationPriceDeviationBps: 500 };
async function now() { return (await ethers.provider.getBlock("latest"))!.timestamp; }
async function feedAt(price: string, updatedAt: number) { const f = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8); await f.waitForDeployment(); await (await (f as any).setRoundData(1n, ethers.parseUnits(price, 8), updatedAt, updatedAt, 1n)).wait(); return f; }

async function fixture() {
  const [owner] = await ethers.getSigners();
  const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy(); await wbnb.waitForDeployment();
  const topaz = await (await ethers.getContractFactory("MockTopazFactory")).deploy(); await topaz.waitForDeployment();
  const router = await (await ethers.getContractFactory("MockBnbQuoteTopazRouter")).deploy(await topaz.getAddress(), await wbnb.getAddress()); await router.waitForDeployment();
  const nativeFeed = await feedAt("800", await now());
  // The adapter only requires code at the locker address at construction; routes never touch it.
  const impl = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(await router.getAddress(), await topaz.getAddress(), await nativeFeed.getAddress(), 3600);
  await impl.waitForDeployment();
  const factoryStandIn = await (await ethers.getContractFactory("MockTopazFactory")).deploy(); await factoryStandIn.waitForDeployment();
  const adapter = new ethers.Contract(await impl.getAddress(), ADAPTER_ABI, owner);
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const mkQuote = async (sym: string, wbnbDepth: string, stable = false) => {
    const q = await MockERC20.deploy(`${sym} token`, sym, ethers.parseEther("1000000"), owner.address); await q.waitForDeployment();
    const pool = await topaz.createPool.staticCall(await wbnb.getAddress(), await q.getAddress(), stable);
    await (await topaz.createPool(await wbnb.getAddress(), await q.getAddress(), stable)).wait();
    await (await (wbnb as any).deposit({ value: ethers.parseEther(wbnbDepth) })).wait();
    await (await (wbnb as any).transfer(pool, ethers.parseEther(wbnbDepth))).wait();
    const feed = await feedAt("1", await now());
    return { symbol: sym, quoteToken: await q.getAddress(), oracleFeed: await feed.getAddress(), acquisitionPool: pool, feed };
  };
  return { owner, adapter, impl, factoryStandIn, mkQuote };
}

describe("BNB quote routes configuration", function () {
  it("requires the factory binding, then configures from re-derived facts and skips identical routes", async function () {
    const f = await fixture();
    await expect(requireFactoryBound(f.adapter, await f.factoryStandIn.getAddress())).to.be.rejectedWith(/expected .* locked/);
    await (await f.impl.setCampaignFactoryOnce(await f.factoryStandIn.getAddress())).wait();
    await requireFactoryBound(f.adapter, await f.factoryStandIn.getAddress());
    const usdt = await f.mkQuote("USDT", "40"); // 40 WBNB * $800 * 2 = $64k
    const dry = await configureRoutes({ adapter: f.adapter, routes: [usdt], policy: POLICY, send: false, nowSeconds: await now() });
    expect(dry[0].action).to.equal("would-configure");
    expect((await f.adapter.quoteRoutes(usdt.quoteToken)).enabled).to.equal(false);
    const sent = await configureRoutes({ adapter: f.adapter, routes: [usdt], policy: POLICY, send: true, nowSeconds: await now() });
    expect(sent[0].action).to.equal("configured");
    const stored = await f.adapter.quoteRoutes(usdt.quoteToken);
    expect(stored.enabled).to.equal(true);
    expect(Number(stored.maxGraduationPriceDeviationBps)).to.equal(500);
    expect((await configureRoutes({ adapter: f.adapter, routes: [usdt], policy: POLICY, send: true, nowSeconds: await now() }))[0].action).to.equal("unchanged");
  });

  it("refuses a thin pool, a stale feed and a stable pool -- and configures nothing", async function () {
    const f = await fixture();
    await (await f.impl.setCampaignFactoryOnce(await f.factoryStandIn.getAddress())).wait();
    const thin = await f.mkQuote("ETH", "1");
    await expect(configureRoutes({ adapter: f.adapter, routes: [thin], policy: POLICY, send: true, nowSeconds: await now() })).to.be.rejectedWith(/below the \$50000 floor/);
    const stale = await f.mkQuote("BTCB", "40"); const t = await now();
    await (await (stale.feed as any).setRoundData(2n, ethers.parseUnits("1", 8), t - 4000, t - 4000, 2n)).wait();
    await expect(configureRoutes({ adapter: f.adapter, routes: [stale], policy: POLICY, send: true, nowSeconds: t })).to.be.rejectedWith(/feed is \d+s old, adapter allows 3600s/);
    const stablePool = await f.mkQuote("USDC", "40", true);
    await expect(configureRoutes({ adapter: f.adapter, routes: [stablePool], policy: POLICY, send: true, nowSeconds: await now() })).to.be.rejectedWith(/no volatile Topaz WBNB pool|stable pool/);
    for (const r of [thin, stale, stablePool]) expect((await f.adapter.quoteRoutes(r.quoteToken)).enabled).to.equal(false);
  });
});
