import { expect } from "chai";
import { ethers } from "hardhat";
import { deployEvmGen, E, DAY, buyNative, buyTokens, increaseTime, mineAt, now, req, type Env } from "./fixtures/evmgenCore";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";

/**
 * The API side of the EVM launch generation (branch claude/evm-app-api) against the compiled
 * generation 6 factory and generation 5 campaign: the create signature from
 * frontend/api/dev-fix/routeAuthorizationSigner.js, the first-buy pricing from
 * frontend/api/lib/evmLaunchGen6.js and the coin-page reader frontend/api/lib/evmGen5CampaignState.js.
 * In-process hardhat chain only.
 */

const signerModule = () => import("../frontend/api/dev-fix/routeAuthorizationSigner.js");
const gen6Module = () => import("../frontend/api/lib/evmLaunchGen6.js");
const stateModule = () => import("../frontend/api/lib/evmGen5CampaignState.js");

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    name: "App Api Six",
    symbol: "AAS",
    logoURI: "ipfs://app-api-six",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: 0n,
    ...overrides,
  };
}

async function deadline() {
  return BigInt((await now()) + 3600);
}

async function apiCreate(env: Env, opts: { feeChoice: number | string; feeCreatorPct?: number; firstBuyTokens?: bigint; maxCostDelta?: bigint }) {
  const { signCreateAuthorization } = await signerModule();
  const { prepareGen6CreateOptions, readGen6FactoryCreateContext } = await gen6Module();
  const factoryAddress = await env.factory.getAddress();
  const factoryGeneration = Number(await env.factory.FACTORY_GENERATION());

  let maxCost = 0n;
  if (opts.firstBuyTokens) {
    const ctx = await readGen6FactoryCreateContext({ provider: ethers.provider, factoryAddress, graduationTarget: 0 });
    const { quoteGen6CreatorFirstBuy } = await gen6Module();
    maxCost = quoteGen6CreatorFirstBuy({ tokens: opts.firstBuyTokens, ...ctx }).cost + (opts.maxCostDelta ?? 0n);
  }
  const prepared = await prepareGen6CreateOptions({
    source: {
      feeChoice: opts.feeChoice,
      feeCreatorPct: opts.feeCreatorPct ?? 0,
      firstBuyTokens: (opts.firstBuyTokens ?? 0n).toString(),
      firstBuyMaxCost: maxCost.toString(),
    },
    graduationTarget: "0",
    readContext: ({ graduationTarget }: any) => readGen6FactoryCreateContext({ provider: ethers.provider, factoryAddress, graduationTarget }),
  });
  const request = { ...baseRequest(), ...prepared.requestFields };
  const dl = await deadline();
  const signature = await signCreateAuthorization({
    signer: env.authority,
    chainId: (await ethers.provider.getNetwork()).chainId,
    factoryAddress,
    creator: env.creator.address,
    request,
    factoryGeneration,
    tradeRouteProfileId: 1,
    finalizeRouteProfileId: 1,
    deadline: dl,
  });
  const tx = await env.factory
    .connect(env.creator)
    .createCampaignAuthorized(request, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature }, { value: BigInt(prepared.requestFields.firstBuyMaxCost) });
  const count = await env.factory.campaignsCount();
  const info = await env.factory.getCampaign(count - 1n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  return { tx, campaign, prepared, request };
}

describe("evm app API against the generation 6 factory", function () {
  it("signs an 11-field create with a first buy and split choice that the factory accepts; the quote equals the chain's", async () => {
    const env = await deployEvmGen();
    expect(Number(await env.factory.FACTORY_GENERATION())).to.eq(6);
    const tokens = E(5_000_000);
    const { tx, campaign, prepared } = await apiCreate(env, { feeChoice: "split", feeCreatorPct: 30, firstBuyTokens: tokens });
    await expect(tx).to.emit(env.factory, "CampaignCreated");
    await expect(tx)
      .to.emit(campaign, "CreatorFirstBuy")
      .withArgs(env.creator.address, tokens, BigInt(prepared.firstBuy.costNoFee), BigInt(prepared.firstBuy.fee));
    const choice = await env.factory.campaignFeeChoice(await campaign.getAddress());
    expect(choice.choice).to.eq(3);
    expect(choice.creatorPct).to.eq(30);
  });

  it("the API refuses what the chain would refuse: max cost below the cost, and more than 10% of supply", async () => {
    const env = await deployEvmGen();
    await expectRejectCode(apiCreate(env, { feeChoice: 1, firstBuyTokens: E(1_000_000), maxCostDelta: -1n }), "GEN6_FIRST_BUY_MAX_COST_TOO_LOW");
    await expectRejectCode(apiCreate(env, { feeChoice: 1, firstBuyTokens: E(100_000_001), maxCostDelta: 0n }), "GEN6_FIRST_BUY_TOO_LARGE");
  });

  it("a scheduled create signed by the API for generation 6/5 is accepted", async () => {
    const env = await deployEvmGen();
    const { signScheduledCreateAuthorization } = await signerModule();
    const request = { ...baseRequest({ symbol: "SCH" }), firstBuyTokens: 0n, firstBuyMaxCost: 0n, feeChoice: 2, feeCreatorPct: 0 };
    const launchAt = BigInt((await now()) + 3600);
    const scheduled = {
      campaign: request,
      launchAt,
      draftReferenceHash: ethers.id("draft"),
      normalizedTickerHash: ethers.id("SCH"),
      metadataHash: ethers.id("meta"),
      reservationVersion: 1n,
      authorizationNonce: 7n,
    };
    const dl = await deadline();
    const signature = await signScheduledCreateAuthorization({
      signer: env.authority,
      chainId: 31337,
      factoryAddress: await env.factory.getAddress(),
      creator: env.creator.address,
      request: scheduled,
      ...scheduled,
      factoryGeneration: 6,
      campaignGeneration: 5,
      tradeRouteProfileId: 1,
      finalizeRouteProfileId: 1,
      deadline: dl,
    });
    await expect(
      env.factory.connect(env.creator).createScheduledCampaignAuthorized(scheduled, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature }),
    ).to.emit(env.factory, "CampaignCreated");
  });

  it("campaign-state reads the fee, quotes, escrow and graduation exactly as the contracts report them", async () => {
    const env = await deployEvmGen();
    const { readGen5CampaignState, parseGen5QuoteParams } = await stateModule();
    const { campaign } = await apiCreate(env, { feeChoice: "keep" });
    const address = await campaign.getAddress();

    // inside the anti-sniper window
    await mineAt(Number(await campaign.launchAt()) + 5);
    let state: any = await readGen5CampaignState({
      provider: ethers.provider,
      campaignAddress: address,
      quoteParams: parseGen5QuoteParams({ buyNativeWei: E(1).toString() }),
    });
    expect(state.supported).to.eq(true);
    expect(state.generation.campaignGeneration).to.eq(5);
    expect(state.tradeFee.currentBps).to.eq(Number(await campaign.currentTradeFeeBps()));
    expect(state.tradeFee.currentBps).to.be.greaterThan(200);
    expect(state.tradeFee.antiSniperActive).to.eq(true);
    const q = await campaign.quoteBuyExactBnb(E(1));
    expect(state.quotes.buyExactNative.feeWei).to.eq(q.feeWei.toString());
    expect(state.creatorClaims.feeChoice.name).to.eq("keep");

    // the creator's own buy goes to escrow
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyTokens(env, campaign, env.creator, E(1_000_000));
    const buyTime = await now();
    state = await readGen5CampaignState({ provider: ethers.provider, campaignAddress: address, wallet: env.creator.address });
    expect(state.tradeFee.currentBps).to.eq(200);
    expect(state.creatorEscrow.totalTokens).to.eq(E(1_000_000).toString());
    expect(state.creatorEscrow.lockedTokens).to.eq(E(1_000_000).toString());
    expect(state.creatorEscrow.nextRelease.at).to.eq(buyTime + 30 * DAY);
    expect(state.creatorEscrow.nextRelease.tokens).to.eq(E(200_000).toString());
    expect(state.creatorEscrow.fullyReleasedAt).to.eq(buyTime + 58 * DAY);
    expect(state.graduation.state).to.eq("trading");
    expect(state.graduation.graduate.callable).to.eq(false);
    expect(state.graduation.graduate.reason).to.eq("GraduationNotDue");

    await increaseTime(30 * DAY);
    state = await readGen5CampaignState({ provider: ethers.provider, campaignAddress: address, wallet: env.creator.address });
    expect(state.creatorEscrow.claimableTokens).to.eq((await campaign.creatorEscrowClaimable()).toString());
    expect(state.creatorEscrow.claimableTokens).to.eq(E(200_000).toString());
    expect(state.viewer.canClaimEscrow).to.eq(true);

    // cross the target (the feed may be stale after 30 days in some fixtures; refresh it)
    const t = await now();
    await env.feed.setRoundData(2, 600n * 10n ** 8n, t, t, 2);
    await buyNative(env, campaign, env.alice, E(60));
    state = await readGen5CampaignState({ provider: ethers.provider, campaignAddress: address });
    expect(state.graduation.state).to.eq("pending");
    expect(state.graduation.pendingSince).to.eq(Number(await campaign.pendingSince()));
    expect(state.graduation.graduate.callable).to.eq(true);
    expect(state.graduation.nativeFallbackAvailableAt).to.eq(null, "native coin: no fallback");

    await campaign.graduate();
    state = await readGen5CampaignState({ provider: ethers.provider, campaignAddress: address, wallet: env.creator.address });
    expect(state.graduation.state).to.eq("graduated");
    expect(state.creatorClaims.graduationBeneficiary).to.eq(env.creator.address);
    expect(state.creatorClaims.graduationNativeWei).to.eq((await campaign.pendingCreatorGraduation()).toString());
    expect(BigInt(state.creatorClaims.graduationNativeWei) > 0n).to.eq(true);
    expect(state.viewer.canClaimGraduation).to.eq(true);
  });
});

/** Same wiring as evmgen-core-quote-fallback.spec.ts: a BnbBasicLaunchFactory with native + quote adapters. */
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

describe("evm app API: BNB quote coin and repair against generation 6", function () {
  it("the API's BNB BASIC 6/5 quote signature is accepted; campaign-state reports the dead route and the 7-day native fallback", async () => {
    const q = await deployBnbQuoteWithNative();
    const { signBnbBasicQuoteAuthorization } = await signerModule();
    const { readGen5CampaignState } = await stateModule();
    expect(Number(await q.factory.BASIC_FACTORY_GENERATION())).to.eq(6);
    const r = req();
    const binding = ethers.id("catalog-binding");
    const dl = await deadline();
    const signature = await signBnbBasicQuoteAuthorization({
      signer: q.authority,
      chainId: 31337,
      factoryAddress: await q.factory.getAddress(),
      creator: q.creator.address,
      request: r,
      factoryGeneration: 6,
      campaignGeneration: 5,
      quoteToken: await q.quote.getAddress(),
      quoteCatalogBindingHash: binding,
      adapter: await q.quoteAdapter.getAddress(),
      campaignImplementation: await q.quoteImpl.getAddress(),
      tradeRouteProfileId: 1,
      finalizeRouteProfileId: 1,
      deadline: dl,
    });
    await q.factory
      .connect(q.creator)
      .createBasicQuoteCampaignAuthorized(r, await q.quote.getAddress(), binding, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature });
    const info = await q.factory.getCampaign((await q.factory.campaignsCount()) - 1n);
    const campaign = await ethers.getContractAt("BnbQuoteLaunchCampaign", info.campaign);
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(q as any, campaign, q.alice, E(60));
    await q.quoteAdapter.setBehaviour(true, false, 0, 0, 0, 0, false); // the quote route is dead

    const address = await campaign.getAddress();
    let state: any = await readGen5CampaignState({ provider: ethers.provider, campaignAddress: address });
    const pendingSince = Number(await campaign.pendingSince());
    expect(state.graduation.state).to.eq("pending");
    expect(state.graduation.quoteToken).to.eq(await q.quote.getAddress());
    expect(state.graduation.graduate.callable).to.eq(false);
    expect(state.graduation.graduate.reason).to.eq("adapter down");
    expect(state.graduation.nativeFallbackAvailableAt).to.eq(pendingSince + 7 * DAY);
    expect(state.graduation.nativeFallbackAvailable).to.eq(false);

    await increaseTime(7 * DAY);
    const t = await now();
    await q.feed.setRoundData(2, 600n * 10n ** 8n, t, t, 2);
    state = await readGen5CampaignState({ provider: ethers.provider, campaignAddress: address });
    expect(state.graduation.nativeFallbackAvailable).to.eq(true);
    await campaign.useNativeFallback();
    state = await readGen5CampaignState({ provider: ethers.provider, campaignAddress: address });
    expect(state.graduation.nativeFallback).to.eq(true);
    expect(state.graduation.nativeFallbackAvailable).to.eq(false);
    expect(state.graduation.graduate.callable).to.eq(true);
  });

  it("a start price out of band reads as repair needed", async () => {
    const env = await deployEvmGen();
    const { readGen5CampaignState } = await stateModule();
    const { campaign } = await apiCreate(env, { feeChoice: 2 });
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(env, campaign, env.alice, E(60));
    await env.adapter.setBehaviour(false, false, 0, 0, 0, 51, true);
    const state: any = await readGen5CampaignState({ provider: ethers.provider, campaignAddress: await campaign.getAddress() });
    expect(state.graduation.graduate).to.deep.include({ callable: false, repairNeeded: true, reason: "StartPriceOutOfBand" });
  });
});

async function expectRejectCode(promise: Promise<unknown>, code: string) {
  let caught: any = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${code}`).to.not.eq(null);
  expect(caught.code).to.eq(code);
}
