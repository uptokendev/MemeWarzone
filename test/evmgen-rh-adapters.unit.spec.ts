/**
 * Branch tests for the Robinhood V2 graduation adapters, on mocks (no fork):
 * constructor and binding refusals, caller/request validation, route configuration, callback gating
 * and the price math. The money paths themselves are proven on a 4663 fork in
 * test/evmgen-rh-graduation.fork.spec.ts.
 */
import { expect } from "chai";
import { ethers } from "hardhat";

const WAD = 10n ** 18n;
const Q192 = 1n << 192n;

describe("evmgen-rh: Robinhood V2 graduation adapters (unit, mocks)", function () {
  async function fixture() {
    const [admin, other] = await ethers.getSigners();
    const v3 = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManager")).deploy(await v3.getAddress(), await weth.getAddress());
    const router = await (await ethers.getContractFactory("MockUniswapV3SwapRouter")).deploy(await v3.getAddress(), await weth.getAddress());
    const ethUsd = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const stockUsd = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await ethUsd.setRoundData(1, 2_694_00000000n, now, now, 1);
    await stockUsd.setRoundData(1, 766_00000000n, now, now, 1);
    const stockToken = await (await ethers.getContractFactory("MockERC20")).deploy("Stock", "STK", 10n ** 24n, admin.address);
    await v3.createPool(await weth.getAddress(), await stockToken.getAddress(), 500);
    const acquisitionPool = await v3.getPool(await weth.getAddress(), await stockToken.getAddress(), 500);
    const locker = await (await ethers.getContractFactory("AcceptingReceiver")).deploy();
    const factory = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(await locker.getAddress());
    const native = await (await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2")).deploy(
      await v3.getAddress(),
      await npm.getAddress(),
      await weth.getAddress(),
    );
    const stock = await (await ethers.getContractFactory("RobinhoodStockGraduationAdapterV2")).deploy(
      await v3.getAddress(),
      await npm.getAddress(),
      await router.getAddress(),
      await weth.getAddress(),
      await ethUsd.getAddress(),
      90_000,
    );
    const campaign = await (await ethers.getContractFactory("MockEvmGenRhCampaign")).deploy();
    await campaign.init(ethers.ZeroHash, 10n ** 27n);
    const route = {
      oracleFeed: await stockUsd.getAddress(),
      acquisitionPool,
      acquisitionFeeTier: 500,
      minimumRouteLiquidityUsdWad: 50_000n * WAD,
      maxSwapSlippageBps: 300,
      maxOracleDeviationBps: 0,
      maxPriceImpactBps: 0,
      enabled: true,
    };
    return { admin, other, v3, weth, npm, router, ethUsd, stockUsd, stockToken, acquisitionPool, locker, factory, native, stock, campaign, route };
  }

  async function request(campaign: any, over: Partial<Record<string, any>> = {}) {
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    return {
      token: await campaign.token(),
      quoteToken: ethers.ZeroAddress,
      memeTarget: 10n ** 25n,
      memeMax: 10n ** 26n,
      curvePriceWad: 137_000_000_000n,
      nativeUsdWad: 0n,
      deadline: now + 3600n,
      ...over,
    };
  }

  describe("constructor", () => {
    it("refuses zero addresses, EOAs and a 0.30% tier that is not spacing 60", async () => {
      const f = await fixture();
      const N = await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2");
      await expect(N.deploy(ethers.ZeroAddress, await f.npm.getAddress(), await f.weth.getAddress())).to.be.revertedWithCustomError(N, "ZeroAddress");
      await expect(N.deploy(await f.v3.getAddress(), f.other.address, await f.weth.getAddress())).to.be.revertedWithCustomError(N, "ContractCodeMissing");
      const bad = await (await ethers.getContractFactory("MockEvmGenRhSpacingFactory")).deploy(10);
      await expect(N.deploy(await bad.getAddress(), await f.npm.getAddress(), await f.weth.getAddress())).to.be.revertedWithCustomError(N, "InvalidFeeTier");
      const S = await ethers.getContractFactory("RobinhoodStockGraduationAdapterV2");
      await expect(
        S.deploy(await f.v3.getAddress(), await f.npm.getAddress(), await f.router.getAddress(), await f.weth.getAddress(), await f.ethUsd.getAddress(), 0),
      ).to.be.revertedWithCustomError(S, "InvalidPolicy");
      await expect(
        S.deploy(await f.v3.getAddress(), await f.npm.getAddress(), ethers.ZeroAddress, await f.weth.getAddress(), await f.ethUsd.getAddress(), 1),
      ).to.be.revertedWithCustomError(S, "ZeroAddress");
    });

    it("exposes the locker integration surface (kind 2, fee 3000, getPool via the V3 factory)", async () => {
      const f = await fixture();
      for (const a of [f.native, f.stock]) {
        expect(await a.liquidityKind()).to.equal(2);
        expect(await a.feeTier()).to.equal(3000);
        expect(await a.POOL_FEE()).to.equal(3000);
        expect(await a.TICK_SPACING()).to.equal(60);
        expect(await a.v3Factory()).to.equal(await f.v3.getAddress());
        expect(await a.positionManager()).to.equal(await f.npm.getAddress());
        expect(await a.WETH()).to.equal(await f.weth.getAddress());
        expect(await a.poolFactory()).to.equal(await a.getAddress());
        await expect(a["getPool(address,address,bool)"](await f.weth.getAddress(), await f.stockToken.getAddress(), true)).to.be.revertedWithCustomError(
          a,
          "InvalidPair",
        );
        expect(await a.MAX_MEME_DUST()).to.equal(10n ** 12n);
      }
    });
  });

  describe("factory binding", () => {
    it("admin only, once, refuses zero/EOA/no-locker, reads the locker from the factory", async () => {
      const f = await fixture();
      await expect((f.native.connect(f.other) as any).setCampaignFactoryOnce(await f.factory.getAddress())).to.be.revertedWithCustomError(f.native, "OnlyAdmin");
      await expect(f.native.setCampaignFactoryOnce(ethers.ZeroAddress)).to.be.revertedWithCustomError(f.native, "ZeroAddress");
      await expect(f.native.setCampaignFactoryOnce(f.other.address)).to.be.revertedWithCustomError(f.native, "ContractCodeMissing");
      const noLocker = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(ethers.ZeroAddress);
      await expect(f.native.setCampaignFactoryOnce(await noLocker.getAddress())).to.be.revertedWithCustomError(f.native, "ZeroAddress");
      await expect(f.native.setCampaignFactoryOnce(await f.factory.getAddress()))
        .to.emit(f.native, "CampaignFactoryLocked")
        .withArgs(await f.factory.getAddress(), await f.locker.getAddress());
      expect(await f.native.permanentPositionLocker()).to.equal(await f.locker.getAddress());
      await expect(f.native.setCampaignFactoryOnce(await f.factory.getAddress())).to.be.revertedWithCustomError(f.native, "FactoryAlreadyLocked");
    });
  });

  describe("caller and request validation", () => {
    it("graduate/repairStep before binding: CampaignFactoryMissing", async () => {
      const f = await fixture();
      const r = await request(f.campaign);
      await expect(f.campaign.callGraduate(await f.native.getAddress(), r, 0)).to.be.revertedWithCustomError(f.native, "CampaignFactoryMissing");
      await expect(f.campaign.callRepair(await f.native.getAddress(), r, 0)).to.be.revertedWithCustomError(f.native, "CampaignFactoryMissing");
    });

    it("unregistered caller: UnauthorizedCampaign (EOA and contract)", async () => {
      const f = await fixture();
      await f.native.setCampaignFactoryOnce(await f.factory.getAddress());
      const r = await request(f.campaign);
      await expect(f.campaign.callGraduate(await f.native.getAddress(), r, 0)).to.be.revertedWithCustomError(f.native, "UnauthorizedCampaign");
      await expect(f.native.graduate(r)).to.be.revertedWithCustomError(f.native, "UnauthorizedCampaign");
    });

    it("registered campaign: token mismatch, deadline, bad amounts, wrong paired side", async () => {
      const f = await fixture();
      await f.native.setCampaignFactoryOnce(await f.factory.getAddress());
      await f.stock.setCampaignFactoryOnce(await f.factory.getAddress());
      await f.factory.setCampaign(await f.campaign.getAddress(), true);
      await f.admin.sendTransaction({ to: await f.campaign.getAddress(), value: WAD });
      const n = await f.native.getAddress();
      const s = await f.stock.getAddress();
      const r = await request(f.campaign);
      await expect(f.campaign.callGraduate(n, { ...r, token: await f.weth.getAddress() }, 1)).to.be.revertedWithCustomError(f.native, "TokenMismatch");
      await expect(f.campaign.callGraduate(n, { ...r, deadline: 1n }, 1)).to.be.revertedWithCustomError(f.native, "DeadlineExpired");
      await expect(f.campaign.callGraduate(n, { ...r, memeTarget: 0n }, 1)).to.be.revertedWithCustomError(f.native, "InvalidRequest");
      await expect(f.campaign.callGraduate(n, { ...r, memeMax: r.memeTarget - 1n }, 1)).to.be.revertedWithCustomError(f.native, "InvalidRequest");
      await expect(f.campaign.callGraduate(n, { ...r, curvePriceWad: 0n }, 1)).to.be.revertedWithCustomError(f.native, "InvalidRequest");
      await expect(f.campaign.callGraduate(n, r, 0)).to.be.revertedWithCustomError(f.native, "InvalidRequest");
      await expect(f.campaign.callGraduate(n, { ...r, quoteToken: await f.stockToken.getAddress() }, 1)).to.be.revertedWithCustomError(
        f.native,
        "InvalidPair",
      );
      await expect(f.campaign.callGraduate(s, r, 1)).to.be.revertedWithCustomError(f.stock, "InvalidPair");
      await expect(f.campaign.callGraduate(s, { ...r, quoteToken: await f.stockToken.getAddress() }, 1)).to.be.revertedWithCustomError(
        f.stock,
        "RouteDisabled",
      );
      await expect(f.campaign.callGraduate(s, { ...r, quoteToken: await f.weth.getAddress() }, 1)).to.be.revertedWithCustomError(f.stock, "InvalidPair");
    });

    it("repairStep with no pool: NothingToRepair", async () => {
      const f = await fixture();
      await f.native.setCampaignFactoryOnce(await f.factory.getAddress());
      await f.factory.setCampaign(await f.campaign.getAddress(), true);
      const r = await request(f.campaign);
      await expect(f.campaign.callRepair(await f.native.getAddress(), r, 0)).to.be.revertedWithCustomError(f.native, "NothingToRepair");
    });

    it("the swap callback only answers the pool of an in-flight repair", async () => {
      const f = await fixture();
      await expect(f.native.uniswapV3SwapCallback(1, 0, "0x")).to.be.revertedWithCustomError(f.native, "UnauthorizedCallback");
      await expect((f.stock.connect(f.other) as any).uniswapV3SwapCallback(0, 1, "0x")).to.be.revertedWithCustomError(f.stock, "UnauthorizedCallback");
    });

    it("native adapter accepts ETH only from WETH's unwrap", async () => {
      const f = await fixture();
      await expect(f.admin.sendTransaction({ to: await f.native.getAddress(), value: 1n })).to.be.revertedWithCustomError(f.native, "InvalidPair");
      await expect(f.admin.sendTransaction({ to: await f.stock.getAddress(), value: 1n })).to.be.reverted;
    });
  });

  describe("stock route configuration", () => {
    it("admin only; slippage <= 300 bps; depth > 0; canonical acquisition pool; not WETH", async () => {
      const f = await fixture();
      const stk = await f.stockToken.getAddress();
      await expect((f.stock.connect(f.other) as any).configureStockRoute(stk, f.route)).to.be.revertedWithCustomError(f.stock, "OnlyAdmin");
      await expect(f.stock.configureStockRoute(stk, { ...f.route, maxSwapSlippageBps: 301 })).to.be.revertedWithCustomError(f.stock, "InvalidPolicy");
      await expect(f.stock.configureStockRoute(stk, { ...f.route, minimumRouteLiquidityUsdWad: 0 })).to.be.revertedWithCustomError(f.stock, "InvalidPolicy");
      await expect(f.stock.configureStockRoute(stk, { ...f.route, acquisitionPool: await f.locker.getAddress() })).to.be.revertedWithCustomError(
        f.stock,
        "AcquisitionPoolMismatch",
      );
      await expect(f.stock.configureStockRoute(stk, { ...f.route, acquisitionFeeTier: 777 })).to.be.revertedWithCustomError(f.stock, "InvalidFeeTier");
      await expect(f.stock.configureStockRoute(await f.weth.getAddress(), f.route)).to.be.revertedWithCustomError(f.stock, "InvalidPair");
      await expect(f.stock.configureStockRoute(stk, f.route)).to.emit(f.stock, "StockRouteConfigured");
      // The 8-field layout LaunchFactory reads at create: (feed, pool, fee, depth, slip, dev, impact, enabled).
      const stored = await f.stock.stockRoutes(stk);
      expect(stored.length).to.equal(8);
      expect(stored[7]).to.equal(true);
      expect(stored[4]).to.equal(300);
      expect(stored[5]).to.equal(0);
      expect(stored[6]).to.equal(0);
      // E11: the two reserved fields are enforced by nothing, so any non-zero value is refused.
      await expect(f.stock.configureStockRoute(stk, { ...f.route, maxOracleDeviationBps: 1 })).to.be.revertedWithCustomError(f.stock, "InvalidPolicy");
      await expect(f.stock.configureStockRoute(stk, { ...f.route, maxPriceImpactBps: 1 })).to.be.revertedWithCustomError(f.stock, "InvalidPolicy");
    });

    it("E11: band is 200 bps; a route through a pool above 0.30% (fee 10000) is refused", async () => {
      const f = await fixture();
      const stk = await f.stockToken.getAddress();
      expect(await f.stock.QUOTE_PRICE_BAND_BPS()).to.equal(200n);
      expect(await f.stock.MAX_ACQUISITION_FEE_TIER()).to.equal(3000n);
      // 10000 is a valid V3 tier (spacing 200), so this is the E11 cap, not the tier check.
      expect(await f.v3.feeAmountTickSpacing(10000)).to.equal(200n);
      await expect(f.stock.configureStockRoute(stk, { ...f.route, acquisitionFeeTier: 10000 })).to.be.revertedWithCustomError(f.stock, "InvalidFeeTier");
    });

    it("enabling reads both feeds: a stale or broken feed is refused, disabling is not", async () => {
      const f = await fixture();
      const stk = await f.stockToken.getAddress();
      const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      await f.stockUsd.setRoundData(2, 766_00000000n, now - 95_000n, now - 95_000n, 2);
      await expect(f.stock.configureStockRoute(stk, f.route)).to.be.revertedWithCustomError(f.stock, "OracleStale");
      await f.stockUsd.setRoundData(3, 0n, now, now, 3);
      await expect(f.stock.configureStockRoute(stk, f.route)).to.be.revertedWithCustomError(f.stock, "OracleUnhealthy");
      await f.stockUsd.setRoundData(4, 766_00000000n, now, now, 3);
      await expect(f.stock.configureStockRoute(stk, f.route)).to.be.revertedWithCustomError(f.stock, "OracleUnhealthy");
      await expect(f.stock.configureStockRoute(stk, { ...f.route, enabled: false })).to.emit(f.stock, "StockRouteConfigured");
    });

    it("oracle minimum: native * ETHUSD / STOCKUSD, less the route slippage", async () => {
      const f = await fixture();
      const stk = await f.stockToken.getAddress();
      await f.stock.configureStockRoute(stk, f.route);
      const [oracleOut, minOut] = await f.stock.oracleMinimumStockOut(stk, WAD);
      expect(oracleOut).to.equal((WAD * 2694n * WAD) / (766n * WAD));
      expect(minOut).to.equal((oracleOut * 9700n) / 10_000n);
      await f.stock.configureStockRoute(stk, { ...f.route, enabled: false });
      await expect(f.stock.oracleMinimumStockOut(stk, WAD)).to.be.revertedWithCustomError(f.stock, "RouteDisabled");
    });
  });

  describe("RobinhoodV3PriceMath", () => {
    it("round-trips the curve's price range in both orderings and refuses out-of-range targets", async () => {
      const m = await (await ethers.getContractFactory("MockEvmGenRhPriceMath")).deploy();
      for (const p of [1_000_000_000n, 137_000_000_000n, 596_000_000_000n, 10n ** 15n]) {
        for (const memeIs0 of [true, false]) {
          const s = await m.sqrtFromPrice(p, memeIs0);
          const expected = memeIs0 ? (p * Q192) / WAD : (WAD * Q192) / p;
          expect(s * s <= expected && (s + 1n) * (s + 1n) > expected).to.equal(true);
          const back = await m.priceFromSqrt(s, memeIs0);
          const diff = back > p ? back - p : p - back;
          expect(diff <= 1n || diff * 10n ** 12n <= p).to.equal(true); // 1 wei of sqrt rounding
        }
      }
      await expect(m.sqrtFromPrice(0, true)).to.be.revertedWithCustomError(m, "InvalidPrice");
      // Beyond the full-range ticks: refused before any pool is touched (or by mulDiv overflow).
      await expect(m.sqrtFromPrice(10n ** 57n, false)).to.be.revertedWithCustomError(m, "TargetOutOfRange");
      await expect(m.sqrtFromPrice(10n ** 57n, true)).to.be.reverted;
    });
  });
});
