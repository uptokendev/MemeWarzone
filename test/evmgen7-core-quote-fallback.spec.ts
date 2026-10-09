/**
 * Gen-7 port of evmgen-core-quote-fallback.spec.ts.
 * E12 (founder, 2026-09-30): a quote coin whose route stays dead graduates into the native pool after
 * 7 days in Pending, with the same 2 / 0 / 98 split (gen-7) and the native price checks, callable by anyone.
 * Spec: docs/evm-launch/spec/C5-graduation.md "E12 as built".
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployEvmGen7, deployBnbQuoteGen7, createBnbQuoteCoinGen7, deployViaMockFactory, createCoin, req, E, area, mineAt, buyNative, increaseTime,
  type QuoteEnv,
} from "./fixtures/evmgen7Core";

const W = 10n ** 18n;
const DAYS7 = 7 * 86400;

const deployBnbQuoteWithNative = () => deployBnbQuoteGen7({ ownNativeAdapter: true });
type Q = QuoteEnv;

async function pendingQuoteCoin(q: Q) {
  const { campaign, token } = await createBnbQuoteCoinGen7(q, req());
  await mineAt(Number(await campaign.launchAt()) + 61);
  await buyNative(q as any, campaign, q.alice, E(60));
  expect(await campaign.graduationPending()).to.eq(true);
  // the quote route is dead
  await q.quoteAdapter.setBehaviour(true, false, 0, 0, 0, 0, false);
  await expect(campaign.graduate()).to.be.revertedWith("adapter down");
  return { campaign, token };
}

async function plan(campaign: any) {
  const g = await campaign.getGraduationState();
  const R: bigint = g.graduationBalance;
  const P: bigint = g.finalCurvePrice;
  const protocol = (R * 200n) / 10000n; // gen-7: 2%
  const creator = 0n; // gen-7: no creator share
  const pool = R - protocol - creator;
  const T = (pool * W) / P;
  const B = (await campaign.totalSupply()) - (await campaign.creatorReserve()) - (await campaign.sold());
  return { R, P, protocol, creator, pool, T, B };
}

describe("evmgen7 core E12: native fallback for a quote coin after 7 days in Pending", function () {
  it("refused before 7 days (exact boundary), on a native coin, and in Trading; the quote path is the only one before", async () => {
    const q = await deployBnbQuoteWithNative();
    const { campaign } = await pendingQuoteCoin(q);
    const since = Number(await campaign.pendingSince());
    await mineAt(since + DAYS7 - 2);
    await expect(campaign.connect(q.bob).useNativeFallback()).to.be.revertedWithCustomError(campaign, "NativeFallbackNotDue");
    expect(await campaign.nativeFallback()).to.eq(false);
    // before the switch graduate() still only tries the quote adapter
    await expect(campaign.graduate()).to.be.revertedWith("adapter down");
    expect(await q.nativeAdapter.calls()).to.eq(0n);

    // native coin: nothing to fall back from
    const env = await deployEvmGen7();
    const { campaign: nativeCoin } = await createCoin(env, req());
    await expect(nativeCoin.useNativeFallback()).to.be.revertedWithCustomError(nativeCoin, "NativeFallbackUnavailable");

    // a quote coin still trading (never Pending): not due
    const q2 = await deployBnbQuoteWithNative();
    const { campaign: trading } = await createBnbQuoteCoinGen7(q2, req({ symbol: "TRD" }));
    await increaseTime(DAYS7 + 10);
    await expect(trading.useNativeFallback()).to.be.revertedWithCustomError(trading, "NativeFallbackNotDue");
  });

  it("after 7 days anyone switches; graduate() then builds the native pool: split, price checks, locker and vault registration exact", async () => {
    const q = await deployBnbQuoteWithNative();
    const { campaign, token } = await pendingQuoteCoin(q);
    const since = Number(await campaign.pendingSince());
    await mineAt(since + DAYS7);
    await expect(campaign.connect(q.bob).useNativeFallback())
      .to.emit(campaign, "NativeFallbackCommitted")
      .withArgs(q.bob.address, await q.nativeAdapter.getAddress(), await q.quote.getAddress(), 0n, 0n);
    expect(await campaign.nativeFallback()).to.eq(true);
    expect(await campaign.graduationAdapter()).to.eq(await q.nativeAdapter.getAddress());
    expect(await campaign.graduationQuoteToken()).to.eq(await q.quote.getAddress()); // still names the quote (pull balance)
    await expect(campaign.useNativeFallback()).to.be.revertedWithCustomError(campaign, "NativeFallbackUnavailable");

    const p = await plan(campaign);
    // the native band still applies: 60 bps below P is refused and the switch survives the revert
    await q.nativeAdapter.setBehaviour(false, false, 0, 0, 0, 60, true);
    await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "StartPriceOutOfBand");
    // a native adapter using less than T MEME is refused (native rule, not the quote rule)
    await q.nativeAdapter.setBehaviour(false, false, 0, 1, 0, 0, false);
    await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "AdapterResultInvalid");
    expect(await campaign.graduationPending()).to.eq(true);
    expect(await campaign.nativeFallback()).to.eq(true);

    await q.nativeAdapter.setBehaviour(false, false, 0, 0, 0, 0, false);
    await campaign.connect(q.carol).graduate();
    const lr = await q.nativeAdapter.lastRequest();
    expect(lr.quoteToken).to.eq(ethers.ZeroAddress);
    expect(lr.nativeUsdWad).to.eq(0n);
    expect(lr.memeTarget).to.eq(p.T);
    expect(lr.memeMax).to.eq(p.B);
    expect(lr.curvePriceWad).to.eq(p.P);
    expect(await q.nativeAdapter.lastValue()).to.eq(p.pool); // 98%
    expect(await q.evmRouter.finalizeTotal()).to.eq(p.protocol); // 2%
    expect(await campaign.pendingCreatorGraduation()).to.eq(p.creator); // 0% (gen-7)
    expect(p.protocol + p.creator + p.pool).to.eq(p.R);
    expect(await campaign.pendingCreatorQuote()).to.eq(0n);
    expect(await q.quoteAdapter.calls()).to.eq(0n);

    const g = await campaign.getGraduationState();
    expect(g.graduatedLiquidityTokens).to.eq(p.T);
    expect(g.burnedUnsoldTokens).to.eq(p.B - p.T);
    expect(g.dexPair).to.eq(await q.topazFactory.getPool(await token.getAddress(), await q.wbnb.getAddress(), false));
    const info = await q.locker.poolInfo(g.dexPair);
    expect(info.registered).to.eq(true);
    expect(info.pairedToken).to.eq(await q.wbnb.getAddress()); // D19 registration: native pool, not the quote
    expect(info.memeToken).to.eq(await token.getAddress());
    expect(await q.factory.campaignGraduationRecorded(await campaign.getAddress())).to.eq(true);
    expect(await token.balanceOf(await campaign.getAddress())).to.eq(0n);
  });

  it("quote proceeds held from quote-route repair steps go to the creator's quote pull balance; their MEME stays out of the pool figures", async () => {
    const q = await deployBnbQuoteWithNative();
    const { campaign, token } = await pendingQuoteCoin(q);
    const p0 = await plan(campaign);
    // one quote-route repair step before the route died for good
    await q.quoteAdapter.setBehaviour(false, false, 0, 0, 0, 0, false);
    // gen-7: the spare (budget - T) is only the ~0.01% pool margin (~13,000 tokens), so the steps are scaled down
    // from gen-6's 1,000,000 / 500,000 to fit it; the accounting being checked is the same.
    expect(p0.B - p0.T > E(6_000)).to.eq(true);
    await q.quoteAdapter.setStep(E(4_000), E(42), 0, 0, 0);
    await campaign.repairPool(0);
    expect(await campaign.repairQuoteHeld()).to.eq(E(42));
    expect(await campaign.repairMemeSold()).to.eq(E(4_000));
    await q.quoteAdapter.setBehaviour(true, false, 0, 0, 0, 0, false);

    await mineAt(Number(await campaign.pendingSince()) + DAYS7);
    await expect(campaign.useNativeFallback())
      .to.emit(campaign, "NativeFallbackCommitted")
      .withArgs((await ethers.getSigners())[0].address, await q.nativeAdapter.getAddress(), await q.quote.getAddress(), E(42), E(4_000));
    expect(await campaign.repairQuoteHeld()).to.eq(0n);
    expect(await campaign.pendingCreatorQuote()).to.eq(E(42));
    expect(await campaign.fallbackQuoteMemeSold()).to.eq(E(4_000));
    expect(await q.quote.balanceOf(await campaign.getAddress())).to.eq(E(42));

    // a native repair step after the switch uses the native adapter, native proceeds go into the pool
    await q.owner.sendTransaction({ to: await q.nativeAdapter.getAddress(), value: E(1) });
    await q.nativeAdapter.setStep(E(2_000), E("0.01"), 0, 0, 0);
    await campaign.repairPool(0);
    expect((await q.nativeAdapter.lastStepRequest()).quoteToken).to.eq(ethers.ZeroAddress);
    expect(await campaign.repairNativeHeld()).to.eq(E("0.01"));
    expect(await campaign.repairQuoteHeld()).to.eq(0n);

    await campaign.graduate();
    const lr = await q.nativeAdapter.lastRequest();
    expect(lr.memeMax).to.eq(p0.B - E(6_000));
    expect(await q.nativeAdapter.lastValue()).to.eq(p0.pool + E("0.01"));
    const g = await campaign.getGraduationState();
    // pool figures count the native step (in this pool), not the quote step (in the MEME/quote pool)
    expect(g.graduatedLiquidityTokens).to.eq(p0.T + E(2_000));
    expect(g.burnedUnsoldTokens).to.eq(p0.B - E(6_000) - p0.T);
    expect(await token.balanceOf(await campaign.getAddress())).to.eq(0n);

    // the held quote is claimable by the creator, nothing stranded
    await campaign.connect(q.creator).claimCreatorGraduation(q.creator.address, true);
    expect(await q.quote.balanceOf(q.creator.address)).to.eq(E(42));
    expect(await q.quote.balanceOf(await campaign.getAddress())).to.eq(0n);
  });

  it("retry: a failing native adapter keeps Pending and the switch; a later call graduates", async () => {
    const q = await deployBnbQuoteWithNative();
    const { campaign } = await pendingQuoteCoin(q);
    await mineAt(Number(await campaign.pendingSince()) + DAYS7 + 3600);
    await campaign.useNativeFallback();
    await q.nativeAdapter.setBehaviour(true, false, 0, 0, 0, 0, false);
    await expect(campaign.graduate()).to.be.revertedWith("adapter down");
    expect(await campaign.graduationPending()).to.eq(true);
    expect(await campaign.launched()).to.eq(false);
    expect(await campaign.nativeFallback()).to.eq(true);
    // the quote route reviving does not bring the quote path back
    await q.quoteAdapter.setBehaviour(false, false, 0, 0, 0, 0, false);
    await q.nativeAdapter.setBehaviour(false, false, 0, 0, 0, 0, false);
    await campaign.connect(q.bob).graduate();
    expect(await campaign.launched()).to.eq(true);
    expect(await q.quoteAdapter.calls()).to.eq(0n);
    expect(await q.nativeAdapter.calls()).to.eq(1n);
    await expect(campaign.useNativeFallback()).to.be.revertedWithCustomError(campaign, "Finalized");
  });

  it("Robinhood stock campaign: same fallback, native adapter from the factory", async () => {
    const env = await deployEvmGen7();
    const Adapter = await ethers.getContractFactory("MockGraduationAdapterEvmGen");
    const stockAdapter = await Adapter.deploy(await env.topazFactory.getAddress(), await env.wbnb.getAddress());
    const nativeAdapter = await Adapter.deploy(await env.topazFactory.getAddress(), await env.wbnb.getAddress());
    await stockAdapter.setLocker(env.carol.address);
    await nativeAdapter.setLocker(env.carol.address);
    const stock = await (await ethers.getContractFactory("MockERC20")).deploy("SPY", "SPY", E("1000000000000"), await stockAdapter.getAddress());
    const m = await deployViaMockFactory(env, "RobinhoodStockLaunchCampaignGen7", { graduationAdapter: await nativeAdapter.getAddress() });
    const { mockFactory, router } = m;
    const addr = await mockFactory.create.staticCall(await m.impl.getAddress(), m.params);
    await m.create();
    const campaign = await ethers.getContractAt("RobinhoodStockLaunchCampaignGen7", addr);
    await mockFactory.configure(addr, await stock.getAddress(), await stockAdapter.getAddress());
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(env, campaign, env.alice, E(60));
    expect(await campaign.graduationPending()).to.eq(true);
    await stockAdapter.setBehaviour(true, false, 0, 0, 0, 0, false);
    await mineAt(Number(await campaign.pendingSince()) + DAYS7);
    // no native adapter on the factory: unavailable, nothing changes
    await expect(campaign.useNativeFallback()).to.be.revertedWithCustomError(campaign, "NativeFallbackUnavailable");
    await mockFactory.setNativeGraduationAdapter(await nativeAdapter.getAddress());
    await campaign.connect(env.bob).useNativeFallback();
    const p = await plan(campaign);
    await campaign.connect(env.bob).graduate();
    expect((await nativeAdapter.lastRequest()).quoteToken).to.eq(ethers.ZeroAddress);
    expect(await nativeAdapter.lastValue()).to.eq(p.pool);
    expect(await router.finalizeTotal()).to.eq(p.protocol);
    expect(await campaign.pendingCreatorGraduation()).to.eq(p.creator);
    expect(await stockAdapter.calls()).to.eq(0n);
    expect(await mockFactory.notifications()).to.eq(1n);
    void area;
  });
});
