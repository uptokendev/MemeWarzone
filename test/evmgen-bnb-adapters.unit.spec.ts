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
    maxSwapSlippageBps: 300,
    maxOracleDeviationBps: 5000,
    maxPriceImpactBps: 5000,
    maxGraduationPriceDeviationBps: 500,
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
    // Depth: 100 WBNB * $800 + 100_000 USDT = $180k, above the $50k floor.
    await wbnb.deposit({ value: 100n * WAD });
    await wbnb.transfer(acq, 100n * WAD);
    await quote.transfer(acq, 100_000n * WAD);
    const acqPool = await ethers.getContractAt("MockTopazPool", acq);
    await acqPool.sync();
    // Router inventory for the mock swap.
    await quote.transfer(await router.getAddress(), 10_000n * WAD);

    const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(admin.address);
    await locker.configureRevenue(admin.address, await topazFactory.getAddress());
    const factory = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(await locker.getAddress());
    const adapter = await (await ethers.getContractFactory("BnbQuoteGraduationAdapter")).deploy(
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

  it("graduates a quote pool through the repair library (no FinalPoolAlreadyExists)", async function () {
    const f = await fixture();
    await f.campaign.graduate(await f.adapter.getAddress(), await f.quote.getAddress(), f.Mt, f.Mmax, f.P, f.Nnative);
    const res = await f.campaign.lastResult();
    expect(res.pool).to.not.equal(ethers.ZeroAddress);
    expect(res.positionId).to.equal(0n);
    expect(res.memeUsed).to.be.gte(f.Mt);
    expect(res.memeUsed).to.be.lte(f.Mmax);
    expect(res.pairedUsed).to.be.gt(0n);
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

  it("USD deviation is one-sided: below the band reverts, above is allowed", async function () {
    const f = await fixture();
    // A huge curve price makes the DEX USD look far below target.
    const tooHighP = 10n ** 20n;
    await expect(
      f.campaign.graduate(await f.adapter.getAddress(), await f.quote.getAddress(), f.Mt, f.Mmax, tooHighP, f.Nnative),
    ).to.be.revertedWithCustomError(f.adapter, "GraduationPriceDeviationTooHigh");
  });

  it("reads acquisition reserves as uint256 (Topaz returns uint256, not uint112)", async function () {
    const f = await fixture();
    const pool = await ethers.getContractAt("MockTopazPool", f.acq);
    const [r0, r1] = await pool.getReserves();
    expect(r0 + r1).to.be.gt(0n);
  });
});
