import { expect } from "chai";
import { ethers } from "hardhat";
import { deployEvmGen, req, E, area, mineAt, buyTokens, buyNative, hashReq, now, coder } from "./fixtures/evmgenCore";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";

const firstBuyCost = (tokens: bigint) => area(tokens) + (area(tokens) * 200n) / 10000n;

async function deployBnbQuote() {
  const env = await deployEvmGen();
  const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaign")).deploy();
  const factory = await (await deployFactoryWithLocker({ factoryName: "BnbBasicLaunchFactory", args: [await env.topazRouter.getAddress(),
    await env.evmRouter.getAddress(),
    await env.impl.getAddress(),
    await env.oracle.getAddress(),
    await quoteImpl.getAddress()] })).factory;
  await env.vault.setFactory(await factory.getAddress());
  const quoteAdapter = await (await ethers.getContractFactory("MockGraduationAdapterEvmGen")).deploy(await env.topazFactory.getAddress(), await env.wbnb.getAddress());
  await quoteAdapter.setLocker(await factory.permanentLpLocker());
  const quote = await (await ethers.getContractFactory("MockERC20")).deploy("USDT", "USDT", E(10n ** 12n), await quoteAdapter.getAddress());
  await factory.setNativeGraduationAdapter(await env.adapter.getAddress());
  await factory.setLaunchTokenDeployer(await env.tokenDeployer.getAddress());
  await factory.setBnbQuoteGraduationAdapter(await quoteAdapter.getAddress());
  await factory.setRouteAuthority(env.authority.address);
  await factory.enableLive();
  const locker = await ethers.getContractAt("PermanentLpLocker", await factory.permanentLpLocker());
  return { ...env, factory, quoteImpl, quoteAdapter, quote, locker };
}

async function createBnbQuoteCoin(q: Awaited<ReturnType<typeof deployBnbQuote>>, r = req(), value = 0n) {
  const binding = ethers.id("catalog-binding");
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const dl = (await now()) + 3600;
  const payload = ethers.keccak256(
    coder.encode(
      ["string", "uint256", "address", "address", "bytes32", "address", "bytes32", "address", "address", "uint32", "uint32", "uint8", "uint8", "uint64"],
      [
        "MWZ_CREATE_BNB_BASIC_QUOTE_AUTH_V2",
        chainId,
        await q.factory.getAddress(),
        q.creator.address,
        hashReq(r),
        await q.quote.getAddress(),
        binding,
        await q.quoteAdapter.getAddress(),
        await q.quoteImpl.getAddress(),
        6,
        5,
        1,
        1,
        dl,
      ],
    ),
  );
  const signature = await q.authority.signMessage(ethers.getBytes(payload));
  await q.factory
    .connect(q.creator)
    .createBasicQuoteCampaignAuthorized(r, await q.quote.getAddress(), binding, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature }, { value });
  const info = await q.factory.getCampaign((await q.factory.campaignsCount()) - 1n);
  return {
    campaign: await ethers.getContractAt("BnbQuoteLaunchCampaign", info.campaign),
    token: await ethers.getContractAt("LaunchToken", info.token),
  };
}

describe("evmgen core C5 on quote coins", function () {
  it("BNB quote coin: first buy at create, same split, oracle price in the request, residual quote and meme handled, claims", async () => {
    const q = await deployBnbQuote();
    const tokens = E(10_000_000);
    const cost = firstBuyCost(tokens);
    const { campaign, token } = await createBnbQuoteCoin(q, req({ firstBuyTokens: tokens, firstBuyMaxCost: cost }), cost);
    expect(await token.balanceOf(q.creator.address)).to.eq(tokens);
    expect(await campaign.graduationQuoteToken()).to.eq(await q.quote.getAddress());
    expect(await campaign.graduationAdapter()).to.eq(await q.quoteAdapter.getAddress());
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(q as any, campaign, q.alice, E(60));
    expect(await campaign.graduationPending()).to.eq(true);

    const g0 = await campaign.getGraduationState();
    const R = g0.graduationBalance;
    const protocol = (R * 220n) / 10000n;
    const creator = (R * 1980n) / 10000n;
    const pool = R - protocol - creator;
    // the adapter sized the meme side from the quote it acquired: fewer than memeTarget is fine here
    await q.quoteAdapter.setBehaviour(false, false, 0, E(1000), 0, 0, false);
    await q.quoteAdapter.setQuote(E(7), 2);
    await campaign.connect(q.carol).graduate();
    const lr = await q.quoteAdapter.lastRequest();
    expect(lr.quoteToken).to.eq(await q.quote.getAddress());
    expect(lr.nativeUsdWad).to.eq(E(600));
    expect(await q.quoteAdapter.lastValue()).to.eq(pool);
    expect(await q.evmRouter.finalizeTotal()).to.eq(protocol);
    expect(await campaign.pendingCreatorGraduation()).to.eq(creator);
    expect(await campaign.pendingCreatorQuote()).to.eq(E(7));
    const g = await campaign.getGraduationState();
    expect(g.graduatedLiquidityTokens).to.eq(lr.memeTarget - E(1000));
    expect(g.burnedUnsoldTokens).to.eq(lr.memeMax - lr.memeTarget + E(1000));
    expect(await token.balanceOf(await campaign.getAddress())).to.eq(0n);
    const info = await q.locker.poolInfo(g.dexPair);
    expect(info.registered).to.eq(true);

    // native first, quote left for later (a paused quote token cannot hold the native hostage)
    await campaign.connect(q.creator).claimCreatorGraduation(q.bob.address, false);
    expect(await campaign.pendingCreatorQuote()).to.eq(E(7));
    await campaign.connect(q.creator).claimCreatorGraduation(q.bob.address, true);
    expect(await q.quote.balanceOf(q.bob.address)).to.eq(E(7));
    await expect(campaign.connect(q.creator).claimCreatorGraduation(q.bob.address, true)).to.be.revertedWithCustomError(campaign, "NothingToClaim");
  });

  it("BNB quote coin: the binding is set once by the factory and a stale oracle keeps Pending for a retry", async () => {
    const q = await deployBnbQuote();
    const { campaign } = await createBnbQuoteCoin(q);
    expect(await campaign.isBnbQuoteCampaignImplementation()).to.eq(true);
    expect(await campaign.quoteCatalogBindingHash()).to.eq(ethers.id("catalog-binding"));
    await expect(campaign.configureQuoteCatalogBinding(ethers.id("x"))).to.be.revertedWithCustomError(campaign, "OnlyFactory");
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(q as any, campaign, q.alice, E(60));
    const t = await now();
    await q.feed.setRoundData(2, 0, t, t, 2);
    await expect(campaign.graduate()).to.be.reverted;
    expect(await campaign.graduationPending()).to.eq(true);
    const t2 = await now();
    await q.feed.setRoundData(3, 600n * 10n ** 8n, t2, t2, 3);
    await campaign.connect(q.carol).graduate();
    expect(await campaign.launched()).to.eq(true);
  });

  describe("Robinhood stock campaign", function () {
    async function deployStock() {
      const env = await deployEvmGen();
      const mockFactory = await (await ethers.getContractFactory("MockLaunchFactoryEvmGen")).deploy();
      await mockFactory.setRouteAuthority(env.authority.address);
      const router = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
      const impl = await (await ethers.getContractFactory("RobinhoodStockLaunchCampaign")).deploy();
      const adapter = await (await ethers.getContractFactory("MockGraduationAdapterEvmGen")).deploy(await env.topazFactory.getAddress(), await env.wbnb.getAddress());
      await adapter.setLocker(env.carol.address);
      const stock = await (await ethers.getContractFactory("MockERC20")).deploy("SPY", "SPY", E(10n ** 12n), await adapter.getAddress());
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
        graduationAdapter: await env.adapter.getAddress(),
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
      const token = await ethers.getContractAt("LaunchToken", await campaign.token());
      return { env, mockFactory, router, campaign, token, adapter, stock };
    }

    it("completion is permissionless and never reverts on dust: meme burned, native and stock to the creator", async () => {
      const { env, mockFactory, router, campaign, token, adapter, stock } = await deployStock();
      expect(await campaign.isStockCampaignImplementation()).to.eq(true);
      await mockFactory.configure(await campaign.getAddress(), await stock.getAddress(), await adapter.getAddress());
      const fb = E(5_000_000);
      const k = 850n;
      const fbCost = area(fb, 1_000_000_000n, k) + (area(fb, 1_000_000_000n, k) * 200n) / 10000n;
      await mockFactory.firstBuy(await campaign.getAddress(), fb, { value: fbCost });
      expect(await token.balanceOf(env.creator.address)).to.eq(fb);
      await mineAt(Number(await campaign.launchAt()) + 61);
      await buyNative(env, campaign, env.alice, E(60));
      expect(await campaign.graduationPending()).to.eq(true);
      const g0 = await campaign.getGraduationState();
      const R = g0.graduationBalance;
      const creatorShare = (R * 1980n) / 10000n;
      await env.owner.sendTransaction({ to: await adapter.getAddress(), value: E(1) });
      await adapter.setBehaviour(false, false, 0, 12345n, 777n, 0, false); // dust everywhere
      await adapter.setQuote(999n, 3);
      await campaign.connect(env.bob).graduate(); // anyone
      expect(await campaign.launched()).to.eq(true);
      expect(await campaign.pendingCreatorGraduation()).to.eq(creatorShare + 777n);
      expect(await campaign.pendingCreatorQuote()).to.eq(999n);
      expect(await router.finalizeTotal()).to.eq((R * 220n) / 10000n);
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
