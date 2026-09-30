/**
 * Audit 5 HOLDS: BnbQuoteGraduationAdapter admin is a constructor argument, the
 * quote feed is immutable after first set, and a 100 bps route cap refuses the
 * 4.5% honest-admin sandwich. The Robinhood stock HOLDS below is the staging
 * test from e099b0f6; this file only rewrites the BNB exploits.
 *
 *   npx hardhat test test/audit5-quote-adapter-admin.spec.ts
 */
import { expect } from "chai";
import { ethers } from "hardhat";

const WAD = 10n ** 18n;

describe("audit5 HOLDS: quote adapter admin, feed lock, 100 bps sandwich bound", function () {
  const TIGHT = {
    minimumRouteLiquidityUsdWad: 50_000n * WAD,
    maxSwapSlippageBps: 100,
    maxOracleDeviationBps: 100,
    maxPriceImpactBps: 100,
    maxGraduationPriceDeviationBps: 100,
    enabled: true,
  };

  async function bnbFixture(policy = TIGHT) {
    const [deployer, attacker, admin] = await ethers.getSigners();
    const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
    const router = await (await ethers.getContractFactory("MockBnbQuoteTopazRouter")).deploy(
      await topazFactory.getAddress(),
      await wbnb.getAddress(),
    );
    const nativeFeed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const quoteFeed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await nativeFeed.setRoundData(1, 800n * 10n ** 8n, now, now, 1);
    await quoteFeed.setRoundData(1, 1n * 10n ** 8n, now, now, 1);
    const quote = await (await ethers.getContractFactory("MockERC20")).deploy("USDT", "USDT", 10n ** 30n, deployer.address);
    await topazFactory.createPool(await wbnb.getAddress(), await quote.getAddress(), false);
    const acq = await topazFactory.getPool(await wbnb.getAddress(), await quote.getAddress(), false);
    await wbnb.deposit({ value: 125n * WAD });
    await wbnb.transfer(acq, 125n * WAD);
    await quote.transfer(acq, 100_000n * WAD);
    const acqPool = await ethers.getContractAt("MockTopazPool", acq);
    await acqPool.sync();
    await quote.transfer(await router.getAddress(), 10_000n * WAD);

    const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(deployer.address);
    await locker.configureRevenue(deployer.address, await topazFactory.getAddress());
    const factory = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(await locker.getAddress());
    const adapter = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(
      admin.address,
      await router.getAddress(),
      await locker.getAddress(),
      await nativeFeed.getAddress(),
      3600,
    );
    await adapter.connect(admin).setCampaignFactoryOnce(await factory.getAddress());
    await adapter.connect(admin).configureQuoteRoute(await quote.getAddress(), {
      oracleFeed: await quoteFeed.getAddress(),
      acquisitionPool: acq,
      ...policy,
    });
    const campaign = await (await ethers.getContractFactory("MockEvmGenRhCampaign")).deploy();
    await campaign.init(ethers.id("audit5-quote"), 10n ** 27n);
    await factory.setCampaign(await campaign.getAddress(), true);
    await ethers.provider.send("hardhat_setBalance", [await campaign.getAddress(), "0x56BC75E2D63100000"]);
    const N = WAD / 10n;
    const P = 10n ** 11n;
    const Mt = (N * WAD) / P;
    return {
      deployer,
      attacker,
      admin,
      topazFactory,
      wbnb,
      router,
      nativeFeed,
      quoteFeed,
      quote,
      acq,
      acqPool,
      locker,
      factory,
      adapter,
      campaign,
      N,
      P,
      Mt,
    };
  }

  async function poolQuote(f: Awaited<ReturnType<typeof bnbFixture>>) {
    const res = await f.campaign.lastResult();
    return f.quote.balanceOf(res.pool);
  }

  it("HOLDS: the adapter admin is the constructor argument, immutable, with no transfer function", async () => {
    const f = await bnbFixture();
    expect(await f.adapter.admin()).to.eq(f.admin.address);
    expect(f.admin.address).to.not.eq(f.deployer.address);
    expect((await ethers.provider.getCode(f.admin.address)).length).to.eq(2);
    const names = f.adapter.interface.fragments.filter((x: any) => x.type === "function").map((x: any) => x.name);
    for (const n of ["transferAdmin", "setAdmin", "transferOwnership", "renounceOwnership"]) expect(names).to.not.include(n);
    const base = {
      oracleFeed: await f.quoteFeed.getAddress(),
      acquisitionPool: f.acq,
      ...TIGHT,
    };
    await expect(f.adapter.connect(f.deployer).configureQuoteRoute(await f.quote.getAddress(), base)).to.be.revertedWithCustomError(
      f.adapter,
      "OnlyAdmin",
    );
    await expect(f.adapter.connect(f.attacker).configureQuoteRoute(await f.quote.getAddress(), base)).to.be.revertedWithCustomError(
      f.adapter,
      "OnlyAdmin",
    );
  });

  it("baseline: an honest route graduates at the fair rate (~79.7 USDT for 0.1 BNB)", async () => {
    const f = await bnbFixture();
    await f.campaign.graduate(await f.adapter.getAddress(), await f.quote.getAddress(), f.Mt, 2n * f.Mt, f.P, f.N);
    const q = await poolQuote(f);
    expect(q).to.be.gt(79n * WAD);
    expect(q).to.be.lt(80n * WAD);
  });

  it("HOLDS: with the honest feed, a front-run that moves the acquisition pool 100x is refused (OracleDeviationTooHigh)", async () => {
    const f = await bnbFixture();
    const wbnbIs0 = (await f.acqPool.token0()) === (await f.wbnb.getAddress());
    await f.acqPool.setReserves(wbnbIs0 ? 1250n * WAD : 10_000n * WAD, wbnbIs0 ? 10_000n * WAD : 1250n * WAD);
    await expect(
      f.campaign.graduate(await f.adapter.getAddress(), await f.quote.getAddress(), f.Mt, 2n * f.Mt, f.P, f.N),
    ).to.be.revertedWithCustomError(f.adapter, "OracleDeviationTooHigh");
  });

  it("HOLDS: the admin cannot swap in its own USDT/USD feed after the first configure", async () => {
    const f = await bnbFixture();
    const fake = await (await ethers.getContractFactory("MockUsdPriceFeed")).connect(f.attacker).deploy(8);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await fake.connect(f.attacker).setRoundData(1, 100n * 10n ** 8n, now, now, 1);
    await expect(
      f.adapter.connect(f.admin).configureQuoteRoute(await f.quote.getAddress(), {
        oracleFeed: await fake.getAddress(),
        acquisitionPool: f.acq,
        ...TIGHT,
      }),
    ).to.be.revertedWithCustomError(f.adapter, "RouteFeedImmutable");
  });

  it("HOLDS: a 500 bps route is refused, and the 4.5% reserve move reverts at 100 bps", async () => {
    const f = await bnbFixture();
    await expect(
      f.adapter.connect(f.admin).configureQuoteRoute(await f.quote.getAddress(), {
        oracleFeed: await f.quoteFeed.getAddress(),
        acquisitionPool: f.acq,
        ...TIGHT,
        maxOracleDeviationBps: 500,
        maxPriceImpactBps: 500,
        maxGraduationPriceDeviationBps: 500,
      }),
    ).to.be.revertedWithCustomError(f.adapter, "InvalidPolicy");

    const rw = (127_900n * WAD) / 1000n;
    const ru = 97_717n * WAD;
    const wbnbIs0 = (await f.acqPool.token0()) === (await f.wbnb.getAddress());
    await f.acqPool.setReserves(wbnbIs0 ? rw : ru, wbnbIs0 ? ru : rw);
    await expect(
      f.campaign.graduate(await f.adapter.getAddress(), await f.quote.getAddress(), f.Mt, 2n * f.Mt, f.P, f.N),
    ).to.be.revertedWithCustomError(f.adapter, "OracleDeviationTooHigh");
  });
});

describe("audit5 HOLDS (Robinhood stock adapter, was EXPLOIT)", function () {
  it("the admin is the Safe passed to the constructor, not the deployer; re-pointing a configured stock at a 100x feed is refused (RouteFixed)", async () => {
    const [deployer, attacker, safe] = await ethers.getSigners();
    const v3 = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManager")).deploy(await v3.getAddress(), await weth.getAddress());
    const router = await (await ethers.getContractFactory("MockUniswapV3SwapRouter")).deploy(await v3.getAddress(), await weth.getAddress());
    const ethUsd = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const stockUsd = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await ethUsd.setRoundData(1, 2_694_00000000n, now, now, 1);
    await stockUsd.setRoundData(1, 766_00000000n, now, now, 1);
    const stock = await (await ethers.getContractFactory("MockERC20")).deploy("SPY", "SPY", 10n ** 24n, deployer.address);
    await v3.createPool(await weth.getAddress(), await stock.getAddress(), 500);
    const acq = await v3.getPool(await weth.getAddress(), await stock.getAddress(), 500);
    await stock.transfer(acq, 1_000n * WAD);
    const adapter = await (await ethers.getContractFactory("RobinhoodStockGraduationAdapterV2")).deploy(
      await v3.getAddress(), await npm.getAddress(), await router.getAddress(), await weth.getAddress(), await ethUsd.getAddress(), 90_000, safe.address,
    );
    expect(await adapter.admin()).to.eq(safe.address);
    expect(await adapter.admin()).to.not.eq(deployer.address);
    const route = { oracleFeed: await stockUsd.getAddress(), acquisitionPool: acq, acquisitionFeeTier: 500, minimumRouteLiquidityUsdWad: 50_000n * WAD, maxSwapSlippageBps: 100, maxOracleDeviationBps: 0, maxPriceImpactBps: 0, enabled: true };
    await expect(adapter.connect(deployer).configureStockRoute(await stock.getAddress(), route)).to.be.revertedWithCustomError(adapter, "OnlyAdmin");
    await adapter.connect(safe).configureStockRoute(await stock.getAddress(), route);
    const [, honestMin] = await adapter.oracleMinimumStockOut(await stock.getAddress(), WAD);

    const fake = await (await ethers.getContractFactory("MockUsdPriceFeed")).connect(attacker).deploy(8);
    await fake.connect(attacker).setRoundData(1, 76_600_00000000n, now, now, 1);
    await expect(
      adapter.connect(safe).configureStockRoute(await stock.getAddress(), { ...route, oracleFeed: await fake.getAddress() }),
    ).to.be.revertedWithCustomError(adapter, "RouteFixed");
    await expect(
      adapter.connect(safe).configureStockRoute(await stock.getAddress(), { ...route, maxSwapSlippageBps: 101 }),
    ).to.be.revertedWithCustomError(adapter, "InvalidPolicy");
    const [, after] = await adapter.oracleMinimumStockOut(await stock.getAddress(), WAD);
    expect(after).to.eq(honestMin);
  });
});
