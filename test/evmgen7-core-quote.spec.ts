import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployEvmGen7, deployBnbQuoteGen7, createBnbQuoteCoinGen7, deployViaMockFactory, req, E, area, curveFor, mineAt, buyTokens, buyNative,
} from "./fixtures/evmgen7Core";

const DEFAULT_CURVE = curveFor(50_000, 600);
const firstBuyCost = (tokens: bigint, c = DEFAULT_CURVE) => area(tokens, c) + (area(tokens, c) * 200n) / 10000n;

describe("evmgen7 core C4 on quote coins", function () {
  it("BNB quote coin: first buy at create, same split, oracle price in the request, residual quote and meme handled, claims", async () => {
    const q = await deployBnbQuoteGen7();
    const tokens = E(10_000_000);
    const cost = firstBuyCost(tokens);
    const { campaign, token } = await createBnbQuoteCoinGen7(q, req({ firstBuyTokens: tokens, firstBuyMaxCost: cost }), cost);
    expect(await token.balanceOf(q.creator.address)).to.eq(tokens);
    expect(await campaign.graduationQuoteToken()).to.eq(await q.quote.getAddress());
    expect(await campaign.graduationAdapter()).to.eq(await q.quoteAdapter.getAddress());
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(q as any, campaign, q.alice, E(60));
    expect(await campaign.graduationPending()).to.eq(true);

    const g0 = await campaign.getGraduationState();
    const R = g0.graduationBalance;
    const protocol = (R * 200n) / 10000n;
    const creator = 0n;
    const pool = R - protocol - creator;
    // the adapter sized the meme side from the quote it acquired: fewer than memeTarget is fine here.
    // Gen-7: the creator has no share, so the native pull balance is fed by an adapter native refund (777 wei) to
    // keep the "native first, quote later" claim path covered.
    await q.owner.sendTransaction({ to: await q.quoteAdapter.getAddress(), value: E(1) });
    await q.quoteAdapter.setBehaviour(false, false, 0, E(1000), 777n, 0, false);
    await q.quoteAdapter.setQuote(E(7), 2);
    await campaign.connect(q.carol).graduate();
    const lr = await q.quoteAdapter.lastRequest();
    expect(lr.quoteToken).to.eq(await q.quote.getAddress());
    expect(lr.nativeUsdWad).to.eq(E(600));
    expect(await q.quoteAdapter.lastValue()).to.eq(pool);
    expect(await q.evmRouter.finalizeTotal()).to.eq(protocol);
    expect(await campaign.pendingCreatorGraduation()).to.eq(creator + 777n);
    expect(await campaign.pendingCreatorQuote()).to.eq(E(7));
    const g = await campaign.getGraduationState();
    expect(g.graduatedLiquidityTokens).to.eq(lr.memeTarget - E(1000));
    expect(g.burnedUnsoldTokens).to.eq(lr.memeMax - lr.memeTarget + E(1000));
    expect(await token.balanceOf(await campaign.getAddress())).to.eq(0n);
    const info = await q.locker.poolInfo(g.dexPair);
    expect(info.registered).to.eq(true);

    // native first, quote left for later (a paused quote token cannot hold the native hostage)
    const bobBefore = await ethers.provider.getBalance(q.bob.address);
    await campaign.connect(q.creator).claimCreatorGraduation(q.bob.address, false);
    expect(await ethers.provider.getBalance(q.bob.address)).to.eq(bobBefore + 777n);
    expect(await campaign.pendingCreatorQuote()).to.eq(E(7));
    await campaign.connect(q.creator).claimCreatorGraduation(q.bob.address, true);
    expect(await q.quote.balanceOf(q.bob.address)).to.eq(E(7));
    await expect(campaign.connect(q.creator).claimCreatorGraduation(q.bob.address, true)).to.be.revertedWithCustomError(campaign, "NothingToClaim");
  });

  it("BNB quote coin: the binding is set once by the factory and a stale oracle keeps Pending for a retry", async () => {
    const q = await deployBnbQuoteGen7();
    const { campaign } = await createBnbQuoteCoinGen7(q);
    expect(await campaign.isBnbQuoteCampaignImplementation()).to.eq(true);
    expect(await campaign.quoteCatalogBindingHash()).to.eq(ethers.id("catalog-binding"));
    await expect(campaign.configureQuoteCatalogBinding(ethers.id("x"))).to.be.revertedWithCustomError(campaign, "OnlyFactory");
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(q as any, campaign, q.alice, E(60));
    const t = (await ethers.provider.getBlock("latest"))!.timestamp;
    await q.feed.setRoundData(2, 0, t, t, 2);
    await expect(campaign.graduate()).to.be.reverted;
    expect(await campaign.graduationPending()).to.eq(true);
    const t2 = (await ethers.provider.getBlock("latest"))!.timestamp;
    await q.feed.setRoundData(3, 600n * 10n ** 8n, t2, t2, 3);
    await campaign.connect(q.carol).graduate();
    expect(await campaign.launched()).to.eq(true);
  });

  describe("Robinhood stock campaign", function () {
    async function deployStock() {
      const env = await deployEvmGen7();
      const adapter = await (await ethers.getContractFactory("MockGraduationAdapterEvmGen")).deploy(await env.topazFactory.getAddress(), await env.wbnb.getAddress());
      await adapter.setLocker(env.carol.address);
      const stock = await (await ethers.getContractFactory("MockERC20")).deploy("SPY", "SPY", E("1000000000000"), await adapter.getAddress());
      // 85 / 13 / 2 with the curve LaunchFactoryGen7 would size for $30K at $600.
      const m = await deployViaMockFactory(env, "RobinhoodStockLaunchCampaignGen7");
      const addr = await m.mockFactory.create.staticCall(await m.impl.getAddress(), m.params);
      await m.create();
      const campaign = await ethers.getContractAt("RobinhoodStockLaunchCampaignGen7", addr);
      const token = await ethers.getContractAt("LaunchToken", await campaign.token());
      return { env, mockFactory: m.mockFactory, router: m.router, curve: m.curve, campaign, token, adapter, stock };
    }

    it("completion is permissionless and never reverts on dust: meme burned, native and stock to the creator", async () => {
      const { env, mockFactory, router, curve, campaign, token, adapter, stock } = await deployStock();
      expect(await campaign.isStockCampaignImplementation()).to.eq(true);
      expect(await campaign.virtualNative()).to.eq(curve.vNative);
      expect(await campaign.virtualToken()).to.eq(curve.vToken);
      await mockFactory.configure(await campaign.getAddress(), await stock.getAddress(), await adapter.getAddress());
      const fb = E(5_000_000);
      const fbCost = firstBuyCost(fb, curve);
      await mockFactory.firstBuy(await campaign.getAddress(), fb, { value: fbCost });
      expect(await token.balanceOf(env.creator.address)).to.eq(fb);
      await mineAt(Number(await campaign.launchAt()) + 61);
      await buyNative(env, campaign, env.alice, E(60));
      expect(await campaign.graduationPending()).to.eq(true);
      const g0 = await campaign.getGraduationState();
      const R = g0.graduationBalance;
      const creatorShare = 0n; // gen-7
      await env.owner.sendTransaction({ to: await adapter.getAddress(), value: E(1) });
      await adapter.setBehaviour(false, false, 0, 12345n, 777n, 0, false); // dust everywhere
      await adapter.setQuote(999n, 3);
      await campaign.connect(env.bob).graduate(); // anyone
      expect(await campaign.launched()).to.eq(true);
      expect(await campaign.pendingCreatorGraduation()).to.eq(creatorShare + 777n);
      expect(await campaign.pendingCreatorQuote()).to.eq(999n);
      expect(await router.finalizeTotal()).to.eq((R * 200n) / 10000n);
      expect(await mockFactory.notifications()).to.eq(1n);
      expect(await mockFactory.lastNotifiedCreator()).to.eq(env.creator.address);
      expect(await token.balanceOf(await campaign.getAddress())).to.eq(0n);
      await campaign.connect(env.creator).claimCreatorGraduation(env.creator.address, true);
      expect(await stock.balanceOf(env.creator.address)).to.eq(999n);
    });

    it("a stock campaign never bound to a stock cannot graduate into a native pool", async () => {
      const { env, campaign } = await deployStock();
      await mineAt(Number(await campaign.launchAt()) + 61);
      await buyNative(env, campaign, env.alice, E(60));
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "StockCampaignNotConfigured");
      void buyTokens;
    });
  });
});
