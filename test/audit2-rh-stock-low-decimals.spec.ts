/**
 * Audit 2 (LOW): the stock target price was computed in raw units (quote raw per 1e18 MEME). For a
 * 6-decimal quote (USDG-like, $1) and a small curve price that is a single-digit integer, so the pool
 * target, the start price and the 200 bps continuity check all rounded by far more than the band.
 * The adapter now derives sqrt prices from the raw amounts themselves (sqrtFromRatio) and checks
 * continuity from sqrtPriceX96, so the rounding is ~1/sqrtPrice, not ~1/price.
 * Real Uniswap V3 bytecode installed locally (no fork).
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";
import { installRealV3, RH_V3, seedFullRangePool } from "./helpers/evmgenRhRealV3";

const WAD = 10n ** 18n;
const Q192 = 1n << 192n;
const SUPPLY = 10n ** 27n;
const RESERVE = 2n * 10n ** 25n;
const USDG = 10n ** 6n;

function isqrt(v: bigint): bigint {
  if (v < 2n) return v;
  let x = 1n << BigInt((v.toString(2).length >> 1) + 1);
  for (;;) {
    const y = (x + v / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

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

async function nowTs() {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
}

describe("audit2 (LOW): stock graduation into a 6-decimal quote keeps the start price within the band", function () {
  this.timeout(600_000);

  async function setup() {
    const [owner] = await ethers.getSigners();
    await network.provider.send("hardhat_setBalance", [owner.address, "0x" + (10n ** 24n).toString(16)]);
    const v3 = await installRealV3();
    const ethUsd = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const usdgUsd = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const t = await nowTs();
    await ethUsd.setRoundData(1, 3000n * 10n ** 8n, t, t, 1);
    await usdgUsd.setRoundData(1, 1n * 10n ** 8n, t, t, 1);
    const usdg = await (await ethers.getContractFactory("MockERC20Decimals")).deploy("USDG", "USDG", 6, 10n ** 12n * USDG, owner.address);
    const usdgAddr = await usdg.getAddress();
    // Deep WETH/USDG pool at the oracle ratio: 3000 USDG per WETH.
    await v3.weth.connect(owner).deposit({ value: ethers.parseEther("3000") });
    await seedFullRangePool(owner, v3.weth, usdg, 3000, ethers.parseEther("3000"), 9_000_000n * USDG);
    const acqPool = await v3.v3Factory.getPool(RH_V3.weth, usdgAddr, 3000);

    const receiver = await (await ethers.getContractFactory("AcceptingReceiver")).deploy();
    const locker = await (await ethers.getContractFactory("PermanentV3PositionLocker")).deploy(owner.address);
    const factory = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(await locker.getAddress());
    const native = await (await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2")).deploy(RH_V3.v3Factory, RH_V3.positionManager, RH_V3.weth, owner.address);
    const adapter = await (await ethers.getContractFactory("RobinhoodStockGraduationAdapterV2")).deploy(
      RH_V3.v3Factory,
      RH_V3.positionManager,
      RH_V3.swapRouter02,
      RH_V3.weth,
      await ethUsd.getAddress(),
      90_000,
      owner.address,
    );
    await locker.configureRevenue(await receiver.getAddress(), await native.getAddress());
    await locker.setIntegrationSourceAuthorized(await adapter.getAddress(), true);
    await adapter.setCampaignFactoryOnce(await factory.getAddress());
    await adapter.configureStockRoute(usdgAddr, {
      oracleFeed: await usdgUsd.getAddress(),
      acquisitionPool: acqPool,
      acquisitionFeeTier: 3000,
      minimumRouteLiquidityUsdWad: 50_000n * WAD,
      maxSwapSlippageBps: 100,
      maxOracleDeviationBps: 0,
      maxPriceImpactBps: 0,
      enabled: true,
    });
    return { owner, v3, usdg, usdgAddr, factory, adapter };
  }

  async function campaignFor(ctx: any, salt: string) {
    const campaign = await (await ethers.getContractFactory("MockEvmGenRhCampaign")).deploy();
    await campaign.init(ethers.id(salt), SUPPLY);
    await ctx.factory.setCampaign(await campaign.getAddress(), true);
    return campaign;
  }

  /** Start price vs curve in USD, bps, from the pool's sqrtPriceX96 at full precision. */
  async function startDevBps(ctx: any, campaign: any, P: bigint) {
    const res = await campaign.lastResult();
    const pool = await ethers.getContractAt(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"], res.pool);
    const [s] = await pool.slot0();
    const memeIs0 = BigInt(await campaign.token()) < BigInt(ctx.usdgAddr);
    // USDG raw per MEME raw = s^2/2^192 (MEME token0) or 2^192/s^2; USD wad per whole MEME at $1 = that * 1e18 * 1e18 / 1e6.
    const num = memeIs0 ? s * s : Q192;
    const den = memeIs0 ? Q192 : s * s;
    const startUsdE36 = (num * WAD * WAD * WAD) / (den * USDG); // extra 1e18 of precision
    const curveUsdE36 = P * 3000n * WAD;
    return Number(((startUsdE36 - curveUsdE36) * 1_000_000n) / curveUsdE36) / 100; // bps with 2 decimals
  }

  for (const sold of [1_000_000n, 30_000_000n, 160_000_000n]) {
    it(`HOLDS: fresh pool, ${sold} whole tokens sold (curve price ${curve(sold).P} wei): graduates, start within the band`, async () => {
      const ctx = await setup();
      const campaign = await campaignFor(ctx, `lowdec-${sold}`);
      const c = curve(sold);
      await ctx.owner.sendTransaction({ to: await campaign.getAddress(), value: c.poolNative });
      // Pre-fix: the raw target (USDG raw per 1e18 MEME) is (P * 3000 / 1e12) -- 5.55 at 1e6 sold -- floored.
      console.log(`      raw target units per 1e18 MEME: ${(c.P * 3000n) / 10n ** 12n}`);
      await campaign.graduate(await ctx.adapter.getAddress(), ctx.usdgAddr, c.T, c.budget, c.P, c.poolNative);
      const dev = await startDevBps(ctx, campaign, c.P);
      console.log(`      start vs curve (USD): ${dev} bps`);
      // Acquisition through a 0.30% pool, no repair: the start sits just under the curve by the fee and impact.
      expect(dev).to.be.gte(-200);
      expect(dev).to.be.lte(0);
      expect(dev).to.be.gte(-100);
    });
  }

  it("HOLDS: a route whose quote has more than 18 decimals is refused (the continuity math is sized for <= 18)", async () => {
    const ctx = await setup();
    const q = await (await ethers.getContractFactory("MockERC20Decimals")).deploy("Q", "Q", 19, 10n ** 30n, ctx.owner.address);
    await ctx.v3.v3Factory.createPool(RH_V3.weth, await q.getAddress(), 3000);
    const route = {
      oracleFeed: (await ctx.adapter.stockRoutes(ctx.usdgAddr))[0],
      acquisitionPool: await ctx.v3.v3Factory.getPool(RH_V3.weth, await q.getAddress(), 3000),
      acquisitionFeeTier: 3000,
      minimumRouteLiquidityUsdWad: 1n,
      maxSwapSlippageBps: 100,
      maxOracleDeviationBps: 0,
      maxPriceImpactBps: 0,
      enabled: true,
    };
    await expect(ctx.adapter.configureStockRoute(await q.getAddress(), route)).to.be.revertedWithCustomError(ctx.adapter, "InvalidPolicy");
    // 18 decimals (every Robinhood Stock Token) and 6 (USDG-like) are accepted.
    const q18 = await (await ethers.getContractFactory("MockERC20Decimals")).deploy("Q18", "Q18", 18, 10n ** 30n, ctx.owner.address);
    await ctx.v3.v3Factory.createPool(RH_V3.weth, await q18.getAddress(), 3000);
    await expect(
      ctx.adapter.configureStockRoute(await q18.getAddress(), { ...route, acquisitionPool: await ctx.v3.v3Factory.getPool(RH_V3.weth, await q18.getAddress(), 3000) }),
    ).to.emit(ctx.adapter, "StockRouteConfigured");
  });
});
