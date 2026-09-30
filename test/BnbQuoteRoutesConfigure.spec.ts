import { expect } from "chai";
import { ethers } from "hardhat";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPTER_ABI, CONFIG_PATH, planFactoryBind, planRoutes, quotePolicyViolations, requireFactoryBound } from "../scripts/configure-bnb-quote-routes";
import { simulateAsAdmin, writeSafeBatch } from "../scripts/lib/safeCallPlan";

const POLICY = { minimumRouteLiquidityUsd: "50000", maxSwapSlippageBps: 100, maxOracleDeviationBps: 100, maxPriceImpactBps: 100, maxGraduationPriceDeviationBps: 100 };
async function now() { return (await ethers.provider.getBlock("latest"))!.timestamp; }
async function feedAt(price: string, updatedAt: number) { const f = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8); await f.waitForDeployment(); await (await (f as any).setRoundData(1n, ethers.parseUnits(price, 8), updatedAt, updatedAt, 1n)).wait(); return f; }

async function fixture() {
  const [owner, safe] = await ethers.getSigners();
  const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy(); await wbnb.waitForDeployment();
  const topaz = await (await ethers.getContractFactory("MockTopazFactory")).deploy(); await topaz.waitForDeployment();
  const router = await (await ethers.getContractFactory("MockBnbQuoteTopazRouter")).deploy(await topaz.getAddress(), await wbnb.getAddress()); await router.waitForDeployment();
  const nativeFeed = await feedAt("800", await now());
  // The adapter only requires code at the locker address at construction; routes never touch it.
  const impl = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(safe.address, await router.getAddress(), await topaz.getAddress(), await nativeFeed.getAddress(), 3600);
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
    // Quote side at the $800 feed, synced: the adapter reads reserves when a route is enabled (L3).
    await (await q.transfer(pool, ethers.parseEther(wbnbDepth) * 800n)).wait();
    await (await (await ethers.getContractAt("MockTopazPool", pool)).sync()).wait();
    const feed = await feedAt("1", await now());
    return { symbol: sym, quoteToken: await q.getAddress(), oracleFeed: await feed.getAddress(), acquisitionPool: pool, feed };
  };
  return { owner, safe, adapter, impl, factoryStandIn, mkQuote };
}

describe("BNB quote routes configuration (the adapter's admin is the Safe)", function () {
  it("config/bnb/mainnet-quote-routes.json and the scanner defaults fit the adapter (every cap <= 100 bps, slippage > 0)", async function () {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    expect(quotePolicyViolations(cfg.policy)).to.deep.equal([]);
    const scanner = fs.readFileSync(path.join(__dirname, "..", "scripts", "scan-bnb-quote-routes.mjs"), "utf8");
    for (const k of ["maxSwapSlippageBps", "maxOracleDeviationBps", "maxPriceImpactBps", "maxGraduationPriceDeviationBps"]) {
      const m = scanner.match(new RegExp(`${k}: (\\d+)`));
      expect(m, `${k} default in the scanner`).to.not.equal(null);
      expect(Number(m![1])).to.be.within(k === "maxSwapSlippageBps" ? 1 : 0, 100);
    }
    const f = await fixture();
    expect(Number(await (f.impl as any).MAX_ROUTE_LIMIT_BPS())).to.equal(100);
    expect(quotePolicyViolations({ ...cfg.policy, maxPriceImpactBps: 101 })).to.have.length(1);
    for (const r of cfg.routes) expect(ethers.isAddress(r.quoteToken) && ethers.isAddress(r.acquisitionPool), r.symbol).to.equal(true);
  });

  it("plans bind + route, simulates them as the Safe (not the deployer), and the executed batch configures the route", async function () {
    const f = await fixture();
    await expect(requireFactoryBound(f.adapter, await f.factoryStandIn.getAddress())).to.be.rejectedWith(/expected .* locked/);
    const usdt = await f.mkQuote("USDT", "40"); // 40 WBNB * $800 * 2 = $64k
    const { calls, results } = await planRoutes({ adapter: f.adapter, routes: [usdt], policy: POLICY, nowSeconds: await now() });
    expect(results[0].adapter).to.equal("configure");
    expect(calls.map((c) => c.fn)).to.deep.equal(["configureQuoteRoute"]);
    await expect(simulateAsAdmin(f.owner.address, calls, () => {})).to.be.rejectedWith(/refused 1 call/);
    await simulateAsAdmin(f.safe.address, calls, () => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-bnb-routes-"));
    try {
      const file = path.join(dir, "Q.json");
      const batch = writeSafeBatch(file, 31337, "test", "bnb quote routes", calls);
      for (const tx of batch.transactions) await (await f.safe.sendTransaction({ to: tx.to, data: tx.data })).wait();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const stored = await f.adapter.quoteRoutes(usdt.quoteToken);
    expect(stored.enabled).to.equal(true);
    expect(Number(stored.maxGraduationPriceDeviationBps)).to.equal(100);
    expect((await planRoutes({ adapter: f.adapter, routes: [usdt], policy: POLICY, nowSeconds: await now() })).calls).to.deep.equal([]);
    // The factory binding: a stand-in that does not name this adapter is refused before anything is planned.
    await expect(planFactoryBind(f.adapter, await f.factoryStandIn.getAddress())).to.be.rejected;
    await (await (f.impl as any).connect(f.safe).setCampaignFactoryOnce(await f.factoryStandIn.getAddress())).wait();
    expect(await planFactoryBind(f.adapter, await f.factoryStandIn.getAddress())).to.equal(null);
  });

  it("refuses a thin pool, a stale feed and a stable pool -- and plans nothing", async function () {
    const f = await fixture();
    const thin = await f.mkQuote("ETH", "1");
    await expect(planRoutes({ adapter: f.adapter, routes: [thin], policy: POLICY, nowSeconds: await now() })).to.be.rejectedWith(/below the \$50000 floor/);
    const stale = await f.mkQuote("BTCB", "40"); const t = await now();
    await (await (stale.feed as any).setRoundData(2n, ethers.parseUnits("1", 8), t - 4000, t - 4000, 2n)).wait();
    await expect(planRoutes({ adapter: f.adapter, routes: [stale], policy: POLICY, nowSeconds: t })).to.be.rejectedWith(/feed is \d+s old, adapter allows 3600s/);
    const stablePool = await f.mkQuote("USDC", "40", true);
    await expect(planRoutes({ adapter: f.adapter, routes: [stablePool], policy: POLICY, nowSeconds: await now() })).to.be.rejectedWith(/no volatile Topaz WBNB pool|stable pool/);
    await expect(planRoutes({ adapter: f.adapter, routes: [], policy: { ...POLICY, maxSwapSlippageBps: 300 }, nowSeconds: await now() })).to.be.rejectedWith(/does not satisfy/);
  });
});
