/**
 * Unit tests for the BNB Topaz graduation adapters and TopazPoolRepair, on mocks (no fork).
 * Spec: docs/evm-launch/spec/C7-bnb-adapters.md sections 4, 7, 8.
 *
 *   npx hardhat test test/evmgen-bnb-adapters.unit.spec.ts
 */
import { expect } from "chai";
import { ethers } from "hardhat";

const WAD = 10n ** 18n;
const BPS = 10_000n;

function isqrt(v: bigint): bigint {
  if (v < 2n) return v;
  let x = 1n << BigInt((v.toString(2).length >> 1) + 1);
  for (;;) {
    const y = (x + v / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

describe("evmgen-bnb: Topaz pool repair library (unit, mocks)", function () {
  async function fixture() {
    const [admin, locker, other] = await ethers.getSigners();
    const factory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
    const meme = await (await ethers.getContractFactory("MockERC20")).deploy("Meme", "MEME", 10n ** 27n, admin.address);
    const harness = await (await ethers.getContractFactory("TopazPoolRepairHarness")).deploy();
    const N = WAD; // 1 paired token
    const Mt = 10n ** 25n;
    const Mmax = 2n * Mt;
    await meme.approve(await harness.getAddress(), ethers.MaxUint256);
    await wbnb.deposit({ value: N * 20n });
    return { admin, locker, other, factory, wbnb, meme, harness, N, Mt, Mmax };
  }

  async function run(f: Awaited<ReturnType<typeof fixture>>, over: { N?: bigint; Mt?: bigint; Mmax?: bigint; donation?: bigint; sync?: boolean; skim?: boolean } = {}) {
    const N = over.N ?? f.N;
    const Mt = over.Mt ?? f.Mt;
    const Mmax = over.Mmax ?? f.Mmax;
    if (over.donation && over.donation > 0n) {
      const pool = await f.factory.getPool(await f.meme.getAddress(), await f.wbnb.getAddress(), false);
      const target = pool === ethers.ZeroAddress
        ? await (async () => {
            await f.factory.createPool(await f.meme.getAddress(), await f.wbnb.getAddress(), false);
            return f.factory.getPool(await f.meme.getAddress(), await f.wbnb.getAddress(), false);
          })()
        : pool;
      await f.wbnb.transfer(target, over.donation);
      if (over.sync) {
        const P = await ethers.getContractAt("MockTopazPool", target);
        await P.sync();
      }
      if (over.skim) {
        const P = await ethers.getContractAt("MockTopazPool", target);
        await P.skim(f.other.address);
      }
    }
    await f.wbnb.transfer(await f.harness.getAddress(), N);
    const args = [
      await f.factory.getAddress(),
      await f.meme.getAddress(),
      await f.wbnb.getAddress(),
      N,
      Mt,
      Mmax,
      f.admin.address,
      f.locker.address,
    ] as const;
    const out = await f.harness.repairAndMint.staticCall(...args);
    await (await f.harness.repairAndMint(...args)).wait();
    return out;
  }

  it("baseline (no pool): m = Mt, price >= N/Mt, locker holds L = totalSupply - 1000", async function () {
    const f = await fixture();
    const out = await run(f);
    expect(out.repaired).to.equal(false);
    expect(out.donationFound).to.equal(0n);
    expect(out.memeUsed).to.equal(f.Mt);
    expect(out.startPriceWad).to.be.gte((f.N * WAD) / f.Mt);
    const pool = await ethers.getContractAt("MockTopazPool", out.pool);
    expect(await pool.totalSupply()).to.equal(out.liquidity + 1000n);
    expect(await pool.balanceOf(f.locker.address)).to.equal(out.liquidity);
    expect(await pool.balanceOf("0x0000000000000000000000000000000000000001")).to.equal(1000n);
    const expectedL = isqrt(f.Mt * f.N) - 1000n;
    expect(out.liquidity).to.equal(expectedL);
  });

  it("createPool only: repaired true, amounts equal to baseline", async function () {
    const f = await fixture();
    await f.factory.createPool(await f.meme.getAddress(), await f.wbnb.getAddress(), false);
    const out = await run(f);
    expect(out.repaired).to.equal(true);
    expect(out.memeUsed).to.equal(f.Mt);
    expect(out.donationFound).to.equal(0n);
  });

  it("donation without sync is absorbed and the price stays at or above target", async function () {
    const f = await fixture();
    const donation = 10n ** 15n;
    const out = await run(f, { donation, sync: false });
    expect(out.donationFound).to.equal(donation);
    expect(out.memeUsed).to.be.gt(f.Mt);
    expect(out.startPriceWad).to.be.gte((f.N * WAD) / f.Mt);
    const pool = await ethers.getContractAt("MockTopazPool", out.pool);
    expect(await f.wbnb.balanceOf(out.pool)).to.equal(f.N + donation);
    expect(await f.meme.balanceOf(out.pool)).to.equal(out.memeUsed);
    expect(await pool.totalSupply()).to.equal(out.liquidity + 1000n);
  });

  it("donation + sync (reserves (0, X)): succeeds, today's router path would revert", async function () {
    const f = await fixture();
    const donation = 1n;
    const out = await run(f, { donation, sync: true });
    expect(out.repaired).to.equal(true);
    expect(out.donationFound).to.equal(1n);
    expect(out.memeUsed).to.be.gte(f.Mt);
    expect(out.startPriceWad).to.be.gte((f.N * WAD) / f.Mt);
  });

  it("cap binding: donation large enough that m = Mmax, price above target never below", async function () {
    const f = await fixture();
    // T = (bx+N)*Mt/N; cap binds when bx > N*(Mmax-Mt)/Mt = N
    const donation = f.N * 3n;
    const out = await run(f, { donation, sync: true, Mmax: f.Mt });
    expect(out.memeUsed).to.equal(f.Mt);
    expect(out.startPriceWad).to.be.gt((f.N * WAD) / f.Mt);
  });

  it("front-run skim between donation and mint reduces the donation only", async function () {
    const f = await fixture();
    const out = await run(f, { donation: 10n ** 16n, sync: false, skim: true });
    expect(out.donationFound).to.equal(0n);
    expect(out.memeUsed).to.equal(f.Mt);
  });

  it("totalSupply > 0 fails closed", async function () {
    const f = await fixture();
    await f.factory.createPool(await f.meme.getAddress(), await f.wbnb.getAddress(), false);
    const poolAddr = await f.factory.getPool(await f.meme.getAddress(), await f.wbnb.getAddress(), false);
    const pool = await ethers.getContractAt("MockTopazPool", poolAddr);
    await pool["mint(address,uint256)"](f.other.address, 1n);
    await f.wbnb.transfer(await f.harness.getAddress(), f.N);
    await expect(
      f.harness.repairAndMint(
        await f.factory.getAddress(),
        await f.meme.getAddress(),
        await f.wbnb.getAddress(),
        f.N,
        f.Mt,
        f.Mmax,
        f.admin.address,
        f.locker.address,
      ),
    ).to.be.reverted;
  });

  it("bm large enough that T <= bm fails closed", async function () {
    const f = await fixture();
    await f.factory.createPool(await f.meme.getAddress(), await f.wbnb.getAddress(), false);
    const poolAddr = await f.factory.getPool(await f.meme.getAddress(), await f.wbnb.getAddress(), false);
    await f.meme.transfer(poolAddr, f.Mt * 10n);
    await f.wbnb.transfer(await f.harness.getAddress(), f.N);
    await expect(
      f.harness.repairAndMint(
        await f.factory.getAddress(),
        await f.meme.getAddress(),
        await f.wbnb.getAddress(),
        f.N,
        f.Mt,
        f.Mmax,
        f.admin.address,
        f.locker.address,
      ),
    ).to.be.reverted;
  });

  it("fee-on-transfer paired token fails closed (pool QUOTE must rise by exactly N)", async function () {
    const f = await fixture();
    const feeTok = await (await ethers.getContractFactory("MockFeeOnTransferERC20")).deploy(1000);
    await feeTok.mint(await f.harness.getAddress(), f.N);
    await f.meme.approve(await f.harness.getAddress(), ethers.MaxUint256);
    await expect(
      f.harness.repairAndMint(
        await f.factory.getAddress(),
        await f.meme.getAddress(),
        await feeTok.getAddress(),
        f.N,
        f.Mt,
        f.Mmax,
        f.admin.address,
        f.locker.address,
      ),
    ).to.be.reverted;
  });

  it("zero paired amount, zero Mt, Mmax < Mt all revert", async function () {
    const f = await fixture();
    await f.wbnb.transfer(await f.harness.getAddress(), f.N);
    await expect(
      f.harness.repairAndMint(
        await f.factory.getAddress(),
        await f.meme.getAddress(),
        await f.wbnb.getAddress(),
        0n,
        f.Mt,
        f.Mmax,
        f.admin.address,
        f.locker.address,
      ),
    ).to.be.reverted;
    await expect(
      f.harness.repairAndMint(
        await f.factory.getAddress(),
        await f.meme.getAddress(),
        await f.wbnb.getAddress(),
        f.N,
        0n,
        f.Mmax,
        f.admin.address,
        f.locker.address,
      ),
    ).to.be.reverted;
    await expect(
      f.harness.repairAndMint(
        await f.factory.getAddress(),
        await f.meme.getAddress(),
        await f.wbnb.getAddress(),
        f.N,
        f.Mt,
        f.Mt - 1n,
        f.admin.address,
        f.locker.address,
      ),
    ).to.be.reverted;
  });

  it("swap against a zero-reserve pool reverts (no trade before our mint)", async function () {
    const f = await fixture();
    await f.factory.createPool(await f.meme.getAddress(), await f.wbnb.getAddress(), false);
    const pool = await ethers.getContractAt("MockTopazPool", await f.factory.getPool(await f.meme.getAddress(), await f.wbnb.getAddress(), false));
    await f.wbnb.transfer(await pool.getAddress(), 1n);
    await pool.sync();
    await expect(pool.swap(0n, 1n, f.admin.address, "0x")).to.be.reverted;
  });
});

describe("evmgen-bnb: BnbNativeGraduationAdapter (unit, mocks)", function () {
  async function fixture() {
    const [admin, other] = await ethers.getSigners();
    const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
    const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(admin.address);
    await locker.configureRevenue(admin.address, await topazFactory.getAddress());
    const factory = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(await locker.getAddress());
    const native = await (await ethers.getContractFactory("BnbNativeGraduationAdapter")).deploy(
      await topazFactory.getAddress(),
      await wbnb.getAddress(),
      await locker.getAddress(),
    );
    const campaign = await (await ethers.getContractFactory("MockEvmGenRhCampaign")).deploy();
    await campaign.init(ethers.ZeroHash, 10n ** 27n);
    await factory.setCampaign(await campaign.getAddress(), true);
    await native.setCampaignFactoryOnce(await factory.getAddress());
    const N = WAD;
    const P = 10n ** 11n;
    const Mt = (N * WAD) / P;
    const Mmax = 2n * Mt;
    await ethers.provider.send("hardhat_setBalance", [await campaign.getAddress(), "0x56BC75E2D63100000"]);
    return { admin, other, topazFactory, wbnb, locker, factory, native, campaign, N, P, Mt, Mmax };
  }

  async function req(f: Awaited<ReturnType<typeof fixture>>, over: Record<string, unknown> = {}) {
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    return {
      token: await f.campaign.token(),
      quoteToken: ethers.ZeroAddress,
      memeTarget: f.Mt,
      memeMax: f.Mmax,
      curvePriceWad: f.P,
      nativeUsdWad: 0n,
      deadline: now + 3600n,
      ...over,
    };
  }

  it("constructor refuses zero addresses and EOAs", async function () {
    const f = await fixture();
    const N = await ethers.getContractFactory("BnbNativeGraduationAdapter");
    await expect(N.deploy(ethers.ZeroAddress, await f.wbnb.getAddress(), await f.locker.getAddress())).to.be.revertedWithCustomError(N, "ZeroAddress");
    await expect(N.deploy(await f.topazFactory.getAddress(), f.other.address, await f.locker.getAddress())).to.be.revertedWithCustomError(N, "ContractCodeMissing");
  });

  it("factory binding is admin-only, once, and refuses zero/EOA", async function () {
    const f = await fixture();
    const fresh = await (await ethers.getContractFactory("BnbNativeGraduationAdapter")).deploy(
      await f.topazFactory.getAddress(),
      await f.wbnb.getAddress(),
      await f.locker.getAddress(),
    );
    await expect(fresh.connect(f.other).setCampaignFactoryOnce(await f.factory.getAddress())).to.be.revertedWithCustomError(fresh, "OnlyAdmin");
    await expect(fresh.setCampaignFactoryOnce(ethers.ZeroAddress)).to.be.revertedWithCustomError(fresh, "ZeroAddress");
    await expect(fresh.setCampaignFactoryOnce(f.other.address)).to.be.revertedWithCustomError(fresh, "ContractCodeMissing");
    await expect(fresh.setCampaignFactoryOnce(await f.factory.getAddress())).to.emit(fresh, "CampaignFactoryLocked");
    await expect(fresh.setCampaignFactoryOnce(await f.factory.getAddress())).to.be.revertedWithCustomError(fresh, "FactoryAlreadyLocked");
  });

  it("refuses a non-campaign caller, a token mismatch, a native quoteToken, and a zero value", async function () {
    const f = await fixture();
    const r = await req(f);
    await expect(f.native.graduate(r, { value: f.N })).to.be.revertedWithCustomError(f.native, "UnauthorizedCampaign");
    await expect(f.campaign.callGraduate(await f.native.getAddress(), { ...r, token: await f.wbnb.getAddress() }, f.N)).to.be.revertedWithCustomError(f.native, "TokenMismatch");
    await expect(f.campaign.callGraduate(await f.native.getAddress(), { ...r, quoteToken: await f.wbnb.getAddress() }, f.N)).to.be.revertedWithCustomError(f.native, "InvalidPair");
    await expect(f.campaign.callGraduate(await f.native.getAddress(), r, 0n)).to.be.revertedWithCustomError(f.native, "ZeroLiquidity");
  });

  it("graduates a clean pool: pairedUsed == msg.value, Mt <= memeUsed <= Mmax, adapter holds nothing", async function () {
    const f = await fixture();
    const res = await f.campaign.graduate.staticCall(await f.native.getAddress(), ethers.ZeroAddress, f.Mt, f.Mmax, f.P, f.N);
    await f.campaign.graduate(await f.native.getAddress(), ethers.ZeroAddress, f.Mt, f.Mmax, f.P, f.N);
    expect(res.pairedUsed).to.equal(f.N);
    expect(res.memeUsed).to.equal(f.Mt);
    expect(res.positionId).to.equal(0n);
    expect(res.repaired).to.equal(false);
    expect(res.startPriceWad).to.be.gte(f.P);
    expect(await f.wbnb.balanceOf(await f.native.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await f.native.getAddress())).to.equal(0n);
    await f.locker.registerGraduatedPool(
      await f.campaign.getAddress(),
      f.admin.address,
      f.admin.address,
      res.pool,
      await f.campaign.token(),
      await f.wbnb.getAddress(),
      res.liquidity,
    );
    expect(await f.locker.registeredLpToken(res.pool)).to.equal(true);
  });

  it("repairs a synced 1-wei donation and still graduates", async function () {
    const f = await fixture();
    const token = await f.campaign.token();
    await f.topazFactory.createPool(token, await f.wbnb.getAddress(), false);
    const pool = await f.topazFactory.getPool(token, await f.wbnb.getAddress(), false);
    await f.wbnb.deposit({ value: 1n });
    await f.wbnb.transfer(pool, 1n);
    await (await ethers.getContractAt("MockTopazPool", pool)).sync();
    const tx = await f.campaign.graduate(await f.native.getAddress(), ethers.ZeroAddress, f.Mt, f.Mmax, f.P, f.N);
    const rec = await tx.wait();
    const res = await f.campaign.lastResult();
    expect(res.repaired).to.equal(true);
    expect(res.donationFound).to.equal(1n);
    expect(res.pairedUsed).to.equal(f.N);
    expect(res.memeUsed).to.be.gte(f.Mt);
    expect(res.memeUsed).to.be.lte(f.Mmax);
    expect(rec?.status).to.equal(1);
  });

  it("I1: a holder cannot move MEME into the pool before trading is enabled", async function () {
    const f = await fixture();
    const token = await ethers.getContractAt("LaunchToken", await f.campaign.token());
    const grief = await (await ethers.getContractFactory("MockEvmGenBnbGrief")).deploy();
    await f.campaign.giveMeme(f.other.address, WAD);
    await f.campaign.giveMeme(await grief.getAddress(), WAD);
    await f.topazFactory.createPool(await token.getAddress(), await f.wbnb.getAddress(), false);
    const pool = await f.topazFactory.getPool(await token.getAddress(), await f.wbnb.getAddress(), false);
    await expect(token.connect(f.other).transfer(pool, WAD)).to.be.revertedWithCustomError(token, "TradingNotEnabled");
    await expect(grief.tryTransfer(await token.getAddress(), pool, WAD)).to.be.revertedWithCustomError(token, "TradingNotEnabled");
    await token.connect(f.other).approve(await grief.getAddress(), WAD);
    await expect(grief.tryApproveAndTransferFrom(await token.getAddress(), f.other.address, pool, WAD)).to.be.revertedWithCustomError(token, "TradingNotEnabled");
    expect(await token.balanceOf(pool)).to.equal(0n);
  });
});

describe("evmgen-bnb: BnbQuoteGraduationAdapter (unit, mocks)", function () {
  const POLICY = {
    minimumRouteLiquidityUsdWad: 50_000n * WAD,
    maxSwapSlippageBps: 100,
    maxOracleDeviationBps: 100,
    maxPriceImpactBps: 100,
    maxGraduationPriceDeviationBps: 100,
    enabled: true,
  };

  async function fixture() {
    const [admin, other] = await ethers.getSigners();
    const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const wbnb = await (await ethers.getContractFactory("MockWBNB")).deploy();
    const router = await (await ethers.getContractFactory("MockBnbQuoteTopazRouter")).deploy(await topazFactory.getAddress(), await wbnb.getAddress());
    const nativeFeed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const quoteFeed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await nativeFeed.setRoundData(1, 800n * 10n ** 8n, now, now, 1);
    await quoteFeed.setRoundData(1, 1n * 10n ** 8n, now, now, 1);
    const quote = await (await ethers.getContractFactory("MockERC20")).deploy("USDT", "USDT", 10n ** 30n, admin.address);
    const acq = await topazFactory.createPool.staticCall(await wbnb.getAddress(), await quote.getAddress(), false);
    await topazFactory.createPool(await wbnb.getAddress(), await quote.getAddress(), false);
    // Depth at oracle: 100 WBNB * $800 + 80_000 USDT = $160k, above the $50k floor.
    await wbnb.deposit({ value: 100n * WAD });
    await wbnb.transfer(acq, 100n * WAD);
    await quote.transfer(acq, 80_000n * WAD);
    const acqPool = await ethers.getContractAt("MockTopazPool", acq);
    await acqPool.sync();
    // Router inventory for the mock swap.
    await quote.transfer(await router.getAddress(), 10_000n * WAD);

    const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(admin.address);
    await locker.configureRevenue(admin.address, await topazFactory.getAddress());
    const factory = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(await locker.getAddress());
    const adapter = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(
      admin.address,
      await router.getAddress(),
      await locker.getAddress(),
      await nativeFeed.getAddress(),
      3600,
    );
    await adapter.setCampaignFactoryOnce(await factory.getAddress());
    await adapter.configureQuoteRoute(await quote.getAddress(), {
      oracleFeed: await quoteFeed.getAddress(),
      acquisitionPool: acq,
      ...POLICY,
    });
    const campaign = await (await ethers.getContractFactory("MockEvmGenRhCampaign")).deploy();
    await campaign.init(ethers.id("quote-campaign"), 10n ** 27n);
    await factory.setCampaign(await campaign.getAddress(), true);
    await ethers.provider.send("hardhat_setBalance", [await campaign.getAddress(), "0x56BC75E2D63100000"]);
    const Nnative = WAD / 10n; // 0.1 BNB
    const P = 10n ** 11n;
    const Mt = (Nnative * WAD) / P;
    const Mmax = 2n * Mt;
    return { admin, other, topazFactory, wbnb, router, nativeFeed, quoteFeed, quote, acq, locker, factory, adapter, campaign, Nnative, P, Mt, Mmax };
  }

  it("keeps configureQuoteRoute refusals: WBNB, missing pool, stable pool, bad policy", async function () {
    const f = await fixture();
    const Q = await ethers.getContractFactory("BnbQuoteGraduationAdapter");
    const adapter = f.adapter;
    await expect(
      adapter.configureQuoteRoute(await f.wbnb.getAddress(), {
        oracleFeed: await f.quoteFeed.getAddress(),
        acquisitionPool: f.acq,
        ...POLICY,
      }),
    ).to.be.revertedWithCustomError(Q, "InvalidPair");
    const stray = await (await ethers.getContractFactory("MockERC20")).deploy("X", "X", 1n, f.admin.address);
    await expect(
      adapter.configureQuoteRoute(await stray.getAddress(), {
        oracleFeed: await f.quoteFeed.getAddress(),
        acquisitionPool: f.acq,
        ...POLICY,
      }),
    ).to.be.revertedWithCustomError(Q, "AcquisitionPoolMismatch");
  });

  it("M1: caps every route limit at 100 bps and refuses 0 slippage / 0 floor", async function () {
    const f = await fixture();
    const adapter = f.adapter;
    const quote = await f.quote.getAddress();
    const base = { oracleFeed: await f.quoteFeed.getAddress(), acquisitionPool: f.acq, ...POLICY };
    expect(await adapter.MAX_ROUTE_LIMIT_BPS()).to.equal(100);
    expect(await adapter.admin()).to.equal(f.admin.address);
    await expect(adapter.connect(f.other).configureQuoteRoute(quote, base)).to.be.revertedWithCustomError(adapter, "OnlyAdmin");
    for (const field of ["maxSwapSlippageBps", "maxOracleDeviationBps", "maxPriceImpactBps", "maxGraduationPriceDeviationBps"] as const) {
      await expect(adapter.configureQuoteRoute(quote, { ...base, [field]: 101 })).to.be.revertedWithCustomError(adapter, "InvalidPolicy");
      await expect(adapter.configureQuoteRoute(quote, { ...base, [field]: 10_000 })).to.be.revertedWithCustomError(adapter, "InvalidPolicy");
    }
    await expect(adapter.configureQuoteRoute(quote, { ...base, maxSwapSlippageBps: 0 })).to.be.revertedWithCustomError(adapter, "InvalidPolicy");
    await expect(adapter.configureQuoteRoute(quote, { ...base, minimumRouteLiquidityUsdWad: 0n })).to.be.revertedWithCustomError(adapter, "InvalidPolicy");
  });

  it("M1: the oracle feed is fixed; later calls may only tighten limits or disable", async function () {
    const f = await fixture();
    const adapter = f.adapter;
    const quote = await f.quote.getAddress();
    const otherFeed = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await otherFeed.setRoundData(1, 1n * 10n ** 8n, now, now, 1);
    const base = { oracleFeed: await f.quoteFeed.getAddress(), acquisitionPool: f.acq, ...POLICY };

    await expect(adapter.configureQuoteRoute(quote, { ...base, oracleFeed: await otherFeed.getAddress() })).to.be.revertedWithCustomError(
      adapter,
      "RouteFeedImmutable",
    );
    await expect(adapter.configureQuoteRoute(quote, { ...base, maxSwapSlippageBps: 101 })).to.be.revertedWithCustomError(adapter, "InvalidPolicy");
    await expect(adapter.configureQuoteRoute(quote, { ...base, maxOracleDeviationBps: 101 })).to.be.revertedWithCustomError(adapter, "InvalidPolicy");
    await expect(adapter.configureQuoteRoute(quote, { ...base, minimumRouteLiquidityUsdWad: 49_000n * WAD })).to.be.revertedWithCustomError(
      adapter,
      "RouteLimitLoosened",
    );

    await expect(
      adapter.configureQuoteRoute(quote, {
        ...base,
        maxSwapSlippageBps: 50,
        maxOracleDeviationBps: 80,
        maxPriceImpactBps: 80,
        maxGraduationPriceDeviationBps: 50,
        minimumRouteLiquidityUsdWad: 60_000n * WAD,
      }),
    ).to.emit(adapter, "QuoteRouteConfigured");
    const tightened = await adapter.quoteRoutes(quote);
    expect(tightened.oracleFeed).to.equal(await f.quoteFeed.getAddress());
    expect(tightened.maxSwapSlippageBps).to.equal(50);
    expect(tightened.maxOracleDeviationBps).to.equal(80);
    expect(tightened.maxPriceImpactBps).to.equal(80);
    expect(tightened.maxGraduationPriceDeviationBps).to.equal(50);
    expect(tightened.minimumRouteLiquidityUsdWad).to.equal(60_000n * WAD);
    expect(tightened.enabled).to.equal(true);

    await expect(adapter.configureQuoteRoute(quote, { ...base, maxSwapSlippageBps: 50, maxOracleDeviationBps: 80, maxPriceImpactBps: 80, maxGraduationPriceDeviationBps: 50, minimumRouteLiquidityUsdWad: 60_000n * WAD, enabled: false })).to.emit(
      adapter,
      "QuoteRouteConfigured",
    );
    expect((await adapter.quoteRoutes(quote)).enabled).to.equal(false);

    await expect(
      adapter.configureQuoteRoute(quote, {
        ...base,
        maxSwapSlippageBps: 50,
        maxOracleDeviationBps: 80,
        maxPriceImpactBps: 80,
        maxGraduationPriceDeviationBps: 50,
        minimumRouteLiquidityUsdWad: 60_000n * WAD,
        enabled: true,
      }),
    ).to.emit(adapter, "QuoteRouteConfigured");
    expect((await adapter.quoteRoutes(quote)).enabled).to.equal(true);

    await expect(
      adapter.configureQuoteRoute(quote, {
        ...base,
        maxSwapSlippageBps: 90,
        maxOracleDeviationBps: 80,
        maxPriceImpactBps: 80,
        maxGraduationPriceDeviationBps: 50,
        minimumRouteLiquidityUsdWad: 60_000n * WAD,
      }),
    ).to.be.revertedWithCustomError(adapter, "RouteLimitLoosened");
  });

  it("graduates a quote pool through the repair library (no FinalPoolAlreadyExists)", async function () {
    const f = await fixture();
    await f.campaign.graduate(await f.adapter.getAddress(), await f.quote.getAddress(), f.Mt, f.Mmax, f.P, f.Nnative);
    const res = await f.campaign.lastResult();
    expect(res.pool).to.not.equal(ethers.ZeroAddress);
    expect(res.positionId).to.equal(0n);
    expect(res.memeUsed).to.be.gt(0n);
    expect(res.memeUsed).to.be.lte(f.Mt);
    expect(res.memeUsed).to.be.lte(f.Mmax);
    expect(res.pairedUsed).to.be.gt(0n);
    const memeBal = await (await ethers.getContractAt("LaunchToken", await f.campaign.token())).balanceOf(res.pool);
    const quoteBal = await f.quote.balanceOf(res.pool);
    const nativeUsdWad = 800n * WAD;
    const quoteUsdWad = WAD;
    const curveUsd = (f.P * nativeUsdWad) / WAD;
    const dexUsd = (quoteBal * quoteUsdWad) / memeBal;
    expect(dexUsd).to.be.gte(curveUsd);
    expect(await f.quote.balanceOf(await f.adapter.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await f.adapter.getAddress())).to.equal(0n);
    await f.locker.registerGraduatedPool(
      await f.campaign.getAddress(),
      f.admin.address,
      f.admin.address,
      res.pool,
      await f.campaign.token(),
      await f.quote.getAddress(),
      res.liquidity,
    );
    expect(await f.locker.registeredLpToken(res.pool)).to.equal(true);
  });

  it("repairs a pre-made MEME/QUOTE pool with a synced donation", async function () {
    const f = await fixture();
    const token = await f.campaign.token();
    await f.topazFactory.createPool(token, await f.quote.getAddress(), false);
    const pool = await f.topazFactory.getPool(token, await f.quote.getAddress(), false);
    await f.quote.transfer(pool, 10n ** 15n);
    await (await ethers.getContractAt("MockTopazPool", pool)).sync();
    await f.campaign.graduate(await f.adapter.getAddress(), await f.quote.getAddress(), f.Mt, f.Mmax, f.P, f.Nnative);
    const res = await f.campaign.lastResult();
    expect(res.repaired).to.equal(true);
    expect(res.donationFound).to.equal(10n ** 15n);
    expect(res.pairedUsed).to.be.gt(0n);
  });

  it("L1: sizes MEME from quote acquired at curve USD, so a high curve price opens at or above it", async function () {
    const f = await fixture();
    const highP = 10n ** 13n; // 100x the fixture curve; DEX must still open at or above that USD
    await f.campaign.graduate(await f.adapter.getAddress(), await f.quote.getAddress(), f.Mt, f.Mmax, highP, f.Nnative);
    const res = await f.campaign.lastResult();
    const memeBal = await (await ethers.getContractAt("LaunchToken", await f.campaign.token())).balanceOf(res.pool);
    const quoteBal = await f.quote.balanceOf(res.pool);
    const curveUsd = (highP * 800n * WAD) / WAD;
    const dexUsd = (quoteBal * WAD) / memeBal;
    expect(dexUsd).to.be.gte(curveUsd);
    expect(res.memeUsed).to.be.lt(f.Mt);
  });

  it("reads acquisition reserves as uint256 (Topaz returns uint256, not uint112)", async function () {
    const f = await fixture();
    const pool = await ethers.getContractAt("MockTopazPool", f.acq);
    const [r0, r1] = await pool.getReserves();
    expect(r0 + r1).to.be.gt(0n);
  });

  // A second quote token on the fixture's factory/router with its own acquisition pool.
  async function addQuote(f: Awaited<ReturnType<typeof fixture>>, decimals: number, wbnbReserve: bigint, quoteReserve: bigint) {
    const q = await (await ethers.getContractFactory("MockERC20Decimals")).deploy("Q", "Q", decimals, 10n ** 30n, f.admin.address);
    await f.topazFactory.createPool(await f.wbnb.getAddress(), await q.getAddress(), false);
    const acq = await f.topazFactory.getPool(await f.wbnb.getAddress(), await q.getAddress(), false);
    const pool = await ethers.getContractAt("MockTopazPool", acq);
    const setDepth = async (w: bigint, u: bigint) => {
      const wbnbIs0 = (await pool.token0()) === (await f.wbnb.getAddress());
      await pool.setReserves(wbnbIs0 ? w : u, wbnbIs0 ? u : w);
    };
    await setDepth(wbnbReserve, quoteReserve);
    return { q, acq, pool, setDepth };
  }

  it("L3: a route cannot be enabled below its own liquidity floor (first set and re-enable)", async function () {
    const f = await fixture();
    const adapter = f.adapter;
    // $800 BNB: 10 WBNB + 8,000 Q = $16k, below the $50k floor.
    const t = await addQuote(f, 18, 10n * WAD, 8_000n * WAD);
    const q = await t.q.getAddress();
    const base = { oracleFeed: await f.quoteFeed.getAddress(), acquisitionPool: t.acq, ...POLICY };

    await expect(adapter.configureQuoteRoute(q, base)).to.be.revertedWithCustomError(adapter, "RouteLiquidityTooLow");
    expect((await adapter.quoteRoutes(q)).oracleFeed).to.equal(ethers.ZeroAddress);

    // A disabled first set is not a bind point and is not checked; enabling it is.
    await adapter.configureQuoteRoute(q, { ...base, enabled: false });
    await expect(adapter.configureQuoteRoute(q, base)).to.be.revertedWithCustomError(adapter, "RouteLiquidityTooLow");
    expect((await adapter.quoteRoutes(q)).enabled).to.equal(false);

    // Deepen to 40 WBNB + 32,000 Q = $64k: enabling now succeeds.
    await t.setDepth(40n * WAD, 32_000n * WAD);
    await expect(adapter.configureQuoteRoute(q, base)).to.emit(adapter, "QuoteRouteConfigured");
    expect((await adapter.quoteRoutes(q)).enabled).to.equal(true);

    // Enabled route thins out: a tightening call on the live route is still allowed (graduate
    // re-checks the floor), but disable + re-enable is refused until depth returns.
    await t.setDepth(10n * WAD, 8_000n * WAD);
    await expect(adapter.configureQuoteRoute(q, { ...base, minimumRouteLiquidityUsdWad: 60_000n * WAD })).to.emit(adapter, "QuoteRouteConfigured");
    await adapter.configureQuoteRoute(q, { ...base, minimumRouteLiquidityUsdWad: 60_000n * WAD, enabled: false });
    await expect(adapter.configureQuoteRoute(q, { ...base, minimumRouteLiquidityUsdWad: 60_000n * WAD })).to.be.revertedWithCustomError(
      adapter,
      "RouteLiquidityTooLow",
    );
    // Exactly at the floor is accepted: 37.5 WBNB ($30k) + 30,000 Q = $60k.
    await t.setDepth((375n * WAD) / 10n, 30_000n * WAD);
    await expect(adapter.configureQuoteRoute(q, { ...base, minimumRouteLiquidityUsdWad: 60_000n * WAD })).to.emit(adapter, "QuoteRouteConfigured");
  });

  it("L3: enabling needs both feeds healthy (a stale quote feed cannot enable a route)", async function () {
    const f = await fixture();
    const t = await addQuote(f, 18, 100n * WAD, 80_000n * WAD);
    const stale = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await stale.setRoundData(1, 1n * 10n ** 8n, now - 7200n, now - 7200n, 1);
    const base = { oracleFeed: await stale.getAddress(), acquisitionPool: t.acq, ...POLICY };
    await expect(f.adapter.configureQuoteRoute(await t.q.getAddress(), base)).to.be.revertedWithCustomError(f.adapter, "OracleStale");
  });

  it("L4: the oracle minimumQuoteOut scales to a 6-decimal quote token", async function () {
    const f = await fixture();
    // 100 WBNB + 80,000 Q(6 dec) = $160k at $800/BNB and $1/Q.
    const t = await addQuote(f, 6, 100n * WAD, 80_000n * 10n ** 6n);
    const q = await t.q.getAddress();
    await t.q.transfer(await f.router.getAddress(), 10_000n * 10n ** 6n);
    await f.adapter.configureQuoteRoute(q, { oracleFeed: await f.quoteFeed.getAddress(), acquisitionPool: t.acq, ...POLICY });

    const snap = await ethers.provider.send("evm_snapshot", []);
    // 0.1 BNB * $800 / $1 = 80 Q = 80e6 base units; haircut = 100 bps slippage + 30 bps pool fee.
    const oracleOut = 80n * 10n ** 6n;
    const fee = await f.topazFactory.feeBps();
    const minOut = (oracleOut * (10_000n - 100n - fee)) / 10_000n;
    const afterFee = f.Nnative - (f.Nnative * fee) / 10_000n;
    const expectedOut = (80_000n * 10n ** 6n * afterFee) / (100n * WAD + afterFee);
    await f.campaign.graduate(await f.adapter.getAddress(), q, f.Mt, f.Mmax, f.P, f.Nnative);
    const res = await f.campaign.lastResult();
    expect(res.pairedUsed).to.equal(expectedOut);
    expect(res.pairedUsed).to.be.gte(minOut);
    expect(res.pairedUsed).to.be.lt(oracleOut);
    expect(await t.q.balanceOf(res.pool)).to.equal(expectedOut);
    const memeBal = await (await ethers.getContractAt("LaunchToken", await f.campaign.token())).balanceOf(res.pool);
    const dexUsd = (expectedOut * 10n ** 12n * WAD) / memeBal; // 6-dec quote at $1, scaled to 18
    expect(dexUsd).to.be.gte((f.P * 800n * WAD) / WAD);
    await ethers.provider.send("evm_revert", [snap]);

    // Same pool, quote feed at $0.995 and slippage tightened to 10 bps: every pre-swap bound
    // passes (oracle deviation ~90 bps < 100) but the 6-decimal minimum (~80.08e6) sits above
    // what the pool gives (~79.68e6), so the swap itself refuses.
    const cheap = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(8);
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    await cheap.setRoundData(1, 99_500_000n, now, now, 1);
    const t2 = await addQuote(f, 6, 100n * WAD, 80_000n * 10n ** 6n);
    await t2.q.transfer(await f.router.getAddress(), 10_000n * 10n ** 6n);
    await f.adapter.configureQuoteRoute(await t2.q.getAddress(), {
      oracleFeed: await cheap.getAddress(),
      acquisitionPool: t2.acq,
      ...POLICY,
      maxSwapSlippageBps: 10,
    });
    await expect(
      f.campaign.graduate(await f.adapter.getAddress(), await t2.q.getAddress(), f.Mt, f.Mmax, f.P, f.Nnative),
    ).to.be.revertedWith("slippage");
  });
});
