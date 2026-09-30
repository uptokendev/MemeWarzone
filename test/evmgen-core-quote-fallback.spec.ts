/**
 * E12 (founder, 2026-09-30): a quote coin whose route stays dead graduates into the native pool after
 * 7 days in Pending, with the same 2.2 / 19.8 / 78 split and the native price checks, callable by anyone.
 * Spec: docs/evm-launch/spec/C5-graduation.md "E12 as built".
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployEvmGen, req, E, area, mineAt, buyNative, hashReq, now, coder, increaseTime } from "./fixtures/evmgenCore";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";

const W = 10n ** 18n;
const DAYS7 = 7 * 86400;

async function deployBnbQuoteWithNative() {
  const env = await deployEvmGen();
  const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaign")).deploy();
  const factory = await (
    await deployFactoryWithLocker({
      factoryName: "BnbBasicLaunchFactory",
      args: [await env.topazRouter.getAddress(), await env.evmRouter.getAddress(), await env.impl.getAddress(), await env.oracle.getAddress(), await quoteImpl.getAddress()],
    })
  ).factory;
  await env.vault.setFactory(await factory.getAddress());
  const locker = await ethers.getContractAt("PermanentLpLocker", await factory.permanentLpLocker());
  const Adapter = await ethers.getContractFactory("MockGraduationAdapterEvmGen");
  // The native adapter of THIS factory: it mints the LP to this factory's locker.
  const nativeAdapter = await Adapter.deploy(await env.topazFactory.getAddress(), await env.wbnb.getAddress());
  await nativeAdapter.setLocker(await locker.getAddress());
  const quoteAdapter = await Adapter.deploy(await env.topazFactory.getAddress(), await env.wbnb.getAddress());
  await quoteAdapter.setLocker(await locker.getAddress());
  const quote = await (await ethers.getContractFactory("MockERC20")).deploy("USDT", "USDT", E(10n ** 12n), await quoteAdapter.getAddress());
  await factory.setNativeGraduationAdapter(await nativeAdapter.getAddress());
  await factory.setLaunchTokenDeployer(await env.tokenDeployer.getAddress());
  await factory.setBnbQuoteGraduationAdapter(await quoteAdapter.getAddress());
  await factory.setRouteAuthority(env.authority.address);
  await factory.enableLive();
  return { ...env, factory, quoteImpl, quoteAdapter, nativeAdapter, quote, locker };
}
type Q = Awaited<ReturnType<typeof deployBnbQuoteWithNative>>;

async function pendingQuoteCoin(q: Q) {
  const r = req();
  const binding = ethers.id("catalog-binding");
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const dl = (await now()) + 3600;
  const payload = ethers.keccak256(
    coder.encode(
      ["string", "uint256", "address", "address", "bytes32", "address", "bytes32", "address", "address", "uint32", "uint32", "uint8", "uint8", "uint64"],
      ["MWZ_CREATE_BNB_BASIC_QUOTE_AUTH_V2", chainId, await q.factory.getAddress(), q.creator.address, hashReq(r), await q.quote.getAddress(), binding, await q.quoteAdapter.getAddress(), await q.quoteImpl.getAddress(), 6, 5, 1, 1, dl],
    ),
  );
  const signature = await q.authority.signMessage(ethers.getBytes(payload));
  await q.factory
    .connect(q.creator)
    .createBasicQuoteCampaignAuthorized(r, await q.quote.getAddress(), binding, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature });
  const info = await q.factory.getCampaign((await q.factory.campaignsCount()) - 1n);
  const campaign = await ethers.getContractAt("BnbQuoteLaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);
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
  const protocol = (R * 220n) / 10000n;
  const creator = (R * 1980n) / 10000n;
  const pool = R - protocol - creator;
  const T = (pool * W) / P;
  const B = (await campaign.totalSupply()) - (await campaign.creatorReserve()) - (await campaign.sold());
  return { R, P, protocol, creator, pool, T, B };
}

describe("evmgen core E12: native fallback for a quote coin after 7 days in Pending", function () {
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
    const env = await deployEvmGen();
    const { createCoin } = await import("./fixtures/evmgenCore");
    const { campaign: nativeCoin } = await createCoin(env, req());
    await expect(nativeCoin.useNativeFallback()).to.be.revertedWithCustomError(nativeCoin, "NativeFallbackUnavailable");

    // a quote coin still trading (never Pending): not due
    const q2 = await deployBnbQuoteWithNative();
    const r = req({ symbol: "TRD" });
    const binding = ethers.id("catalog-binding");
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const dl = (await now()) + 3600;
    const payload = ethers.keccak256(
      coder.encode(
        ["string", "uint256", "address", "address", "bytes32", "address", "bytes32", "address", "address", "uint32", "uint32", "uint8", "uint8", "uint64"],
        ["MWZ_CREATE_BNB_BASIC_QUOTE_AUTH_V2", chainId, await q2.factory.getAddress(), q2.creator.address, hashReq(r), await q2.quote.getAddress(), binding, await q2.quoteAdapter.getAddress(), await q2.quoteImpl.getAddress(), 6, 5, 1, 1, dl],
      ),
    );
    const signature = await q2.authority.signMessage(ethers.getBytes(payload));
    await q2.factory.connect(q2.creator).createBasicQuoteCampaignAuthorized(r, await q2.quote.getAddress(), binding, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature });
    const trading = await ethers.getContractAt("BnbQuoteLaunchCampaign", (await q2.factory.getCampaign(0)).campaign);
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
    expect(await q.nativeAdapter.lastValue()).to.eq(p.pool); // 78%
    expect(await q.evmRouter.finalizeTotal()).to.eq(p.protocol); // 2.2%
    expect(await campaign.pendingCreatorGraduation()).to.eq(p.creator); // 19.8%
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
    await q.quoteAdapter.setStep(E(1_000_000), E(42), 0, 0, 0);
    await campaign.repairPool(0);
    expect(await campaign.repairQuoteHeld()).to.eq(E(42));
    expect(await campaign.repairMemeSold()).to.eq(E(1_000_000));
    await q.quoteAdapter.setBehaviour(true, false, 0, 0, 0, 0, false);

    await mineAt(Number(await campaign.pendingSince()) + DAYS7);
    await expect(campaign.useNativeFallback())
      .to.emit(campaign, "NativeFallbackCommitted")
      .withArgs((await ethers.getSigners())[0].address, await q.nativeAdapter.getAddress(), await q.quote.getAddress(), E(42), E(1_000_000));
    expect(await campaign.repairQuoteHeld()).to.eq(0n);
    expect(await campaign.pendingCreatorQuote()).to.eq(E(42));
    expect(await campaign.fallbackQuoteMemeSold()).to.eq(E(1_000_000));
    expect(await q.quote.balanceOf(await campaign.getAddress())).to.eq(E(42));

    // a native repair step after the switch uses the native adapter, native proceeds go into the pool
    await q.owner.sendTransaction({ to: await q.nativeAdapter.getAddress(), value: E(1) });
    await q.nativeAdapter.setStep(E(500_000), E("0.01"), 0, 0, 0);
    await campaign.repairPool(0);
    expect((await q.nativeAdapter.lastStepRequest()).quoteToken).to.eq(ethers.ZeroAddress);
    expect(await campaign.repairNativeHeld()).to.eq(E("0.01"));
    expect(await campaign.repairQuoteHeld()).to.eq(0n);

    await campaign.graduate();
    const lr = await q.nativeAdapter.lastRequest();
    expect(lr.memeMax).to.eq(p0.B - E(1_500_000));
    expect(await q.nativeAdapter.lastValue()).to.eq(p0.pool + E("0.01"));
    const g = await campaign.getGraduationState();
    // pool figures count the native step (in this pool), not the quote step (in the MEME/quote pool)
    expect(g.graduatedLiquidityTokens).to.eq(p0.T + E(500_000));
    expect(g.burnedUnsoldTokens).to.eq(p0.B - E(1_500_000) - p0.T);
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
    const env = await deployEvmGen();
    const mockFactory = await (await ethers.getContractFactory("MockLaunchFactoryEvmGen")).deploy();
    await mockFactory.setRouteAuthority(env.authority.address);
    const router = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
    const impl = await (await ethers.getContractFactory("RobinhoodStockLaunchCampaign")).deploy();
    const Adapter = await ethers.getContractFactory("MockGraduationAdapterEvmGen");
    const stockAdapter = await Adapter.deploy(await env.topazFactory.getAddress(), await env.wbnb.getAddress());
    const nativeAdapter = await Adapter.deploy(await env.topazFactory.getAddress(), await env.wbnb.getAddress());
    await stockAdapter.setLocker(env.carol.address);
    await nativeAdapter.setLocker(env.carol.address);
    const stock = await (await ethers.getContractFactory("MockERC20")).deploy("SPY", "SPY", E(10n ** 12n), await stockAdapter.getAddress());
    const params = {
      name: "Stock",
      symbol: "STK",
      logoURI: "ipfs://s",
      totalSupply: E(1_000_000_000),
      curveBps: 7000,
      liquidityTokenBps: 2800,
      basePrice: 1_000_000_000n,
      priceSlope: 850n,
      graduationTarget: E(30_000),
      graduationOracle: await env.oracle.getAddress(),
      protocolFeeBps: 200,
      graduationAdapter: await nativeAdapter.getAddress(),
      feeRecipient: await router.getAddress(),
      creator: env.creator.address,
      factory: ethers.ZeroAddress,
      riskRegistry: ethers.ZeroAddress,
      tokenDeployer: await env.tokenDeployer.getAddress(),
      creatorBuyCapWei: 0n,
      requireAuthorizedTrading: true,
      tradeRouteProfile: 1,
      finalizeRouteProfile: 1,
    };
    const addr = await mockFactory.create.staticCall(await impl.getAddress(), params);
    await mockFactory.create(await impl.getAddress(), params);
    const campaign = await ethers.getContractAt("RobinhoodStockLaunchCampaign", addr);
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
