import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "hardhat";
import {
  ADAPTER_ABI,
  CONFIG_PATH,
  STOCK_ADAPTER_V2_RULES,
  VAULT_ABI,
  planFactoryBind,
  planRoutes,
  routeStruct,
  stockRouteViolations,
} from "../scripts/configure-robinhood-stock-routes";
import { simulateAsAdmin, writeSafeBatch } from "../scripts/lib/safeCallPlan";

const WAD = 10n ** 18n;
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

async function now() { return (await ethers.provider.getBlock("latest"))!.timestamp; }
async function feedAt(price: string, updatedAt: number) {
  const feed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8); await feed.waitForDeployment();
  await (await (feed as any).setRoundData(1n, ethers.parseUnits(price, 8), updatedAt, updatedAt, 1n)).wait();
  return feed;
}

/** RobinhoodStockGraduationAdapterV2 with the Safe (a separate signer) as its immutable admin, as on 4663. */
async function fixture() {
  const [deployer, safe] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  const v3 = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
  const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManager")).deploy(await v3.getAddress(), await weth.getAddress());
  const router = await (await ethers.getContractFactory("MockUniswapV3SwapRouter")).deploy(await v3.getAddress(), await weth.getAddress());
  const nativeOracle = await feedAt("2600", await now());
  const impl = await (await ethers.getContractFactory("RobinhoodStockGraduationAdapterV2")).deploy(
    await v3.getAddress(), await npm.getAddress(), await router.getAddress(), await weth.getAddress(), await nativeOracle.getAddress(), 90_000, safe.address,
  );
  await impl.waitForDeployment();
  const adapter = new ethers.Contract(await impl.getAddress(), ADAPTER_ABI, deployer);
  const vaultImpl = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(safe.address, deployer.address, await weth.getAddress(), 2, await v3.getAddress(), 86_400);
  await vaultImpl.waitForDeployment();
  const vault = new ethers.Contract(await vaultImpl.getAddress(), VAULT_ABI, deployer);
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  /** A stock with a canonical (WETH, stock, fee) pool holding `stockDepth` whole stock tokens at $100. */
  const mkStock = async (sym: string, stockDepth: string, fee = 500) => {
    const stock = await MockERC20.deploy(`${sym} Stock Token`, sym, ethers.parseUnits("10000000", 18), deployer.address); await stock.waitForDeployment();
    await (await v3.createPool(await weth.getAddress(), await stock.getAddress(), fee)).wait();
    const pool = await v3.getPool(await weth.getAddress(), await stock.getAddress(), fee);
    await (await stock.transfer(pool, ethers.parseUnits(stockDepth, 18))).wait();
    const feed = await feedAt("100", await now());
    return { symbol: sym, stockToken: await stock.getAddress(), oracleFeed: await feed.getAddress(), acquisitionPool: pool, acquisitionFeeTier: fee, feed };
  };
  return { deployer, safe, weth, v3, impl, adapter, vault, mkStock };
}

async function executeBatchAs(signer: any, file: string) {
  const batch = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const tx of batch.transactions) await (await signer.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) })).wait();
  return batch;
}

describe("Robinhood stock routes: config/robinhood/mainnet-stock-routes.json fits RobinhoodStockGraduationAdapterV2", function () {
  it("every row satisfies the adapter's rules (slippage <= 100, reserved fields 0, fee tier <= 3000, floor > 0)", function () {
    expect(cfg.routes.length).to.be.greaterThan(0);
    expect(cfg.policy.maxOracleDeviationBps).to.equal(0);
    expect(cfg.policy.maxPriceImpactBps).to.equal(0);
    expect(cfg.policy.maxSwapSlippageBps).to.be.within(1, STOCK_ADAPTER_V2_RULES.maxSwapSlippageBps);
    for (const r of cfg.routes) {
      expect(stockRouteViolations(r, cfg.policy), r.symbol).to.deep.equal([]);
      expect(ethers.isAddress(r.stockToken) && ethers.isAddress(r.oracleFeed) && ethers.isAddress(r.acquisitionPool), r.symbol).to.equal(true);
      expect(r.stockSideUsdObserved, `${r.symbol} observed stock-side depth`).to.be.at.least(Number(cfg.policy.minimumRouteLiquidityUsd));
    }
    const symbols = cfg.routes.map((r: any) => r.symbol);
    expect(new Set(symbols).size).to.equal(symbols.length);
    expect(new Set(cfg.routes.map((r: any) => r.stockToken.toLowerCase())).size).to.equal(symbols.length);
  });

  it("the routes dropped for having only a 1% pool (or too little stock-side depth) are listed, not silently gone", function () {
    const excluded = (cfg.excluded || []).map((e: any) => e.symbol);
    expect(excluded).to.include.members(["MSTR", "MU", "GLD", "SGOV", "CRCL", "GME"]);
    for (const e of cfg.excluded) {
      expect(e.reason, e.symbol).to.be.a("string").and.not.equal("");
      expect(cfg.routes.some((r: any) => r.symbol === e.symbol), `${e.symbol} is both routed and excluded`).to.equal(false);
    }
  });

  it("a fee-10000 route or the old 300/500/500 policy is refused by the checker the script runs first", function () {
    expect(stockRouteViolations({ symbol: "MSTR", acquisitionFeeTier: 10000 }, cfg.policy)).to.have.length(1);
    const old = { minimumRouteLiquidityUsd: "50000", maxSwapSlippageBps: 300, maxOracleDeviationBps: 500, maxPriceImpactBps: 500 };
    expect(stockRouteViolations({ symbol: "SPY", acquisitionFeeTier: 500 }, old)).to.have.length(3);
  });

  it("the deployed adapter accepts the file's policy on every fee tier the file uses (500 / 3000), and refuses the old one", async function () {
    const f = await fixture();
    // The mock V3 factory has no 100 tier; the fork rehearsal configures USDG (fee 100) on the real one.
    const tiers: number[] = [...new Set<number>(cfg.routes.map((r: any) => Number(r.acquisitionFeeTier)))].filter((t) => t !== 100);
    for (const tier of tiers) {
      const s = await f.mkStock(`T${tier}`, "1000", tier);
      await expect((f.impl as any).connect(f.safe).configureStockRoute(s.stockToken, routeStruct(s, cfg.policy))).to.emit(f.impl, "StockRouteConfigured");
    }
    const s = await f.mkStock("OLD", "1000", 500);
    const old = { minimumRouteLiquidityUsd: "50000", maxSwapSlippageBps: 300, maxOracleDeviationBps: 500, maxPriceImpactBps: 500 };
    await expect((f.impl as any).connect(f.safe).configureStockRoute(s.stockToken, routeStruct(s, old))).to.be.revertedWithCustomError(f.impl, "InvalidPolicy");
    const one = await f.mkStock("ONE", "1000", 10000);
    await expect((f.impl as any).connect(f.safe).configureStockRoute(one.stockToken, routeStruct(one, cfg.policy))).to.be.revertedWithCustomError(f.impl, "InvalidFeeTier");
  });
});

describe("Robinhood stock routes: the Safe-admin path (plan, simulate as the Safe, batch, execute)", function () {
  let outDir: string;
  beforeEach(() => { outDir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-stock-routes-")); });
  afterEach(() => fs.rmSync(outDir, { recursive: true, force: true }));

  it("plans adapter + vault calls, simulates them as the Safe (and not as the deployer), and the batch configures both", async function () {
    const f = await fixture();
    const spy = await f.mkStock("SPY", "1000"); // 1000 x $100 = $100k stock side >= $50k
    const pointer = await (await ethers.getContractFactory("MockStockFactoryPointer")).deploy(await f.adapter.getAddress()); await pointer.waitForDeployment();

    const bind = await planFactoryBind(f.adapter, await pointer.getAddress());
    expect(bind?.fn).to.equal("setCampaignFactoryOnce");
    const { calls, results } = await planRoutes({ adapter: f.adapter, vault: f.vault, routes: [spy], policy: cfg.policy, nowSeconds: await now() });
    expect(calls.map((c) => c.fn)).to.deep.equal(["configureStockRoute", "setQuoteRoute"]);
    expect(results[0].stockSideUsd).to.equal(100_000);
    // The mock factory and mock V3 pool cannot take the bind (no permanentLpLocker) or the vault route (no
    // observation slots); both run for real, as the Safe, on the 4663 fork rehearsal. Here: the adapter calls.
    const adapterCalls = calls.filter((c) => c.contract === "RobinhoodStockGraduationAdapterV2");

    await expect(simulateAsAdmin(f.deployer.address, adapterCalls, () => {})).to.be.rejectedWith(/refused 1 call/);
    await simulateAsAdmin(f.safe.address, adapterCalls, () => {});

    const file = path.join(outDir, "Q.safe-batch.json");
    writeSafeBatch(file, 31337, "test Q", "stock routes", [bind!, ...calls]);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.transactions.map((t: any) => t.contractMethod.name)).to.deep.equal(["setCampaignFactoryOnce", "configureStockRoute", "setQuoteRoute"]);
    expect(written.transactions[1].contractMethod.inputs[1].components).to.have.length(8);
    writeSafeBatch(file, 31337, "test Q", "stock routes", adapterCalls);
    await executeBatchAs(f.safe, file);

    const stored = await f.adapter.stockRoutes(spy.stockToken);
    expect(stored.enabled).to.equal(true);
    expect(stored.acquisitionPool).to.equal(spy.acquisitionPool);
    expect(stored.minimumRouteLiquidityUsdWad).to.equal(50_000n * WAD);
    expect(Number(stored.maxSwapSlippageBps)).to.equal(100);
    expect(Number(stored.maxOracleDeviationBps) + Number(stored.maxPriceImpactBps)).to.equal(0);

    // Re-running plans nothing.
    const again = await planRoutes({ adapter: f.adapter, routes: [spy], policy: cfg.policy, nowSeconds: await now() });
    expect(again.calls).to.deep.equal([]);
  });

  it("refuses a pool whose STOCK side is thin (the adapter's depth rule), a stale feed, a non-canonical pool and a stranger factory", async function () {
    const f = await fixture();
    const thin = await f.mkStock("DELL", "100"); // $10k of stock
    await expect(planRoutes({ adapter: f.adapter, routes: [thin], policy: cfg.policy, nowSeconds: await now() })).to.be.rejectedWith(/of the stock, below the \$50000 floor/);
    const stale = await f.mkStock("GME", "1000");
    const t = await now();
    await (await (stale.feed as any).setRoundData(2n, ethers.parseUnits("100", 8), t - 95_000, t - 95_000, 2n)).wait();
    await expect(planRoutes({ adapter: f.adapter, routes: [stale], policy: cfg.policy, nowSeconds: t })).to.be.rejectedWith(/feed is \d+s old, adapter allows 90000s/);
    const wrongPool = { ...(await f.mkStock("QQQ", "1000")), acquisitionPool: thin.acquisitionPool };
    await expect(planRoutes({ adapter: f.adapter, routes: [wrongPool], policy: cfg.policy, nowSeconds: await now() })).to.be.rejectedWith(/not the canonical/);
    const stranger = await (await ethers.getContractFactory("MockStockFactoryPointer")).deploy(f.deployer.address);
    await expect(planFactoryBind(f.adapter, await stranger.getAddress())).to.be.rejectedWith(/not this one/);
  });
});
