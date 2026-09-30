import { expect } from "chai";
import { ethers } from "hardhat";
import { E, mineAt, buyNative, signCreate, hashReq, req, now } from "./fixtures/evmgenCore";
import { deployBnbBasicCore } from "./helpers/legacy-C";

const BPS = 10_000n;
const FACTORY_GENERATION = 6;
const QUOTE_CAMPAIGN_GENERATION = 5;
const CATALOG_DOMAIN = "MWZ_BNB_BASIC_QUOTE_CATALOG_V1";

type Core = Awaited<ReturnType<typeof deployBnbBasicCore>>;

function buildCatalogBinding(quoteToken: string, overrides: Record<string, any> = {}) {
  const deploymentId = overrides.deploymentId ?? "11111111-2222-3333-4444-555555555555";
  const providerId = overrides.providerId ?? "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const providerKey = overrides.providerKey ?? "bnb-basic-canonical";
  const policyKey = overrides.policyKey ?? "bnb-basic-stable";
  const policyVersion = BigInt(overrides.policyVersion ?? 7);
  const stateVersion = BigInt(overrides.stateVersion ?? 12);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(coder.encode(
    ["string", "string", "address", "string", "string", "string", "uint256", "uint256", "uint32", "uint32"],
    [CATALOG_DOMAIN, deploymentId, quoteToken, providerId, providerKey, policyKey, policyVersion, stateVersion, FACTORY_GENERATION, QUOTE_CAMPAIGN_GENERATION],
  ));
}

async function createNativeCampaign(core: Core) {
  const { factory, creator, authority } = core;
  await (await factory.enableLive()).wait();
  const request = req({ name: "Native Meme", symbol: "NATIVE", logoURI: "ipfs://native" });
  const auth = await signCreate(authority, await factory.getAddress(), creator.address, request);
  await (await factory.connect(creator).createCampaignAuthorized(request, auth)).wait();
  const info = await factory.getCampaign(0);
  return {
    campaign: await ethers.getContractAt("LaunchCampaign", info.campaign),
    token: await ethers.getContractAt("LaunchToken", info.token),
  };
}

async function signBasicQuoteCreate(core: Core, request: any, quoteToken: string, catalogBinding: string, deadline: bigint) {
  const { authority, creator, factory, quoteImpl } = core;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const payloadHash = ethers.keccak256(coder.encode(
    ["string", "uint256", "address", "address", "bytes32", "address", "bytes32", "address", "address", "uint32", "uint32", "uint8", "uint8", "uint64"],
    [
      "MWZ_CREATE_BNB_BASIC_QUOTE_AUTH_V2",
      (await ethers.provider.getNetwork()).chainId,
      await factory.getAddress(),
      await creator.getAddress(),
      hashReq(request),
      quoteToken,
      catalogBinding,
      await factory.bnbQuoteGraduationAdapter(),
      await quoteImpl.getAddress(),
      FACTORY_GENERATION,
      QUOTE_CAMPAIGN_GENERATION,
      1,
      1,
      deadline,
    ],
  ));
  return authority.signMessage(ethers.getBytes(payloadHash));
}

async function createQuoteCampaign(core: Core) {
  const { owner, creator, factory, quoteAdapter } = core;

  const quote = await (await ethers.getContractFactory("MockERC20")).deploy("Canonical USD", "cUSD", E(10n ** 12n), owner.address);
  // The test double "acquires" the quote from its own balance (quotePerNative per native wei).
  await (await quote.transfer(await quoteAdapter.getAddress(), E(10n ** 11n))).wait();

  await (await factory.setBnbQuoteGraduationAdapter(await quoteAdapter.getAddress())).wait();
  await (await factory.enableLive()).wait();

  const request = req({ name: "Stable Meme", symbol: "STABLE", logoURI: "ipfs://stable" });
  const catalogBinding = buildCatalogBinding(await quote.getAddress());
  const deadline = BigInt(await now()) + 3600n;
  const signature = await signBasicQuoteCreate(core, request, await quote.getAddress(), catalogBinding, deadline);
  const routeAuth = { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline, signature };
  const createTx = await factory.connect(creator).createBasicQuoteCampaignAuthorized(request, await quote.getAddress(), catalogBinding, routeAuth);
  await createTx.wait();

  const info = await factory.getCampaign(0);
  const campaign = await ethers.getContractAt("BnbQuoteLaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);
  return { quote, request, deadline, signature, routeAuth, catalogBinding, campaign, token, createTx };
}

/** Past the anti-sniper window, a 60 BNB buy crosses the $30k target at $600: Pending, nothing graduates. */
async function crossThreshold(core: Core, campaign: any) {
  await mineAt(Number(await campaign.launchAt()) + 61);
  await expect(buyNative(core as any, campaign, core.buyer, E(60))).to.emit(campaign, "GraduationPending");
  expect(await campaign.graduationPending()).to.equal(true);
  expect(await campaign.launched()).to.equal(false);
}

describe("BNB BASIC graduation market", function () {
  this.timeout(180_000);

  it("preserves native BNB -> MEME/WBNB graduation and permanent locking", async function () {
    const core = await deployBnbBasicCore();
    const { campaign, token } = await createNativeCampaign(core);
    expect(await campaign.graduationQuoteToken()).to.equal(ethers.ZeroAddress);
    expect(await campaign.graduationAdapter()).to.equal(await core.nativeAdapter.getAddress());

    await crossThreshold(core, campaign);
    await (await campaign.connect(core.other).graduate()).wait();
    expect(await campaign.launched()).to.equal(true);
    expect(await campaign.graduationPending()).to.equal(false);

    const state = await campaign.getGraduationState();
    const pair = state.dexPair;
    expect(pair).to.not.equal(ethers.ZeroAddress);
    expect(pair).to.equal(await core.topazFactory.getPool(await token.getAddress(), await core.wbnb.getAddress(), false));

    const locker = core.locker;
    expect(await locker.registeredLpToken(pair)).to.equal(true);
    expect(await locker.lockedBalance(pair)).to.be.gt(0n);
    expect(await locker.lockedBalance(pair)).to.equal(state.graduatedLiquidityLp);
    const info = await locker.poolInfo(pair);
    expect(info.pairedToken).to.equal(await core.wbnb.getAddress());
    expect(info.memeToken).to.equal(await token.getAddress());
  });

  it("binds the Agent 1 catalog commitment and generation into creation authority", async function () {
    const core = await deployBnbBasicCore();
    const created = await createQuoteCampaign(core);
    expect(await created.campaign.quoteCatalogBindingHash()).to.equal(created.catalogBinding);
    expect(await created.campaign.graduationQuoteToken()).to.equal(await created.quote.getAddress());
    expect(await created.campaign.graduationAdapter()).to.equal(await core.quoteAdapter.getAddress());
    await expect(created.createTx)
      .to.emit(core.factory, "BasicQuoteCampaignConfigured")
      .withArgs(
        await created.campaign.getAddress(),
        await created.token.getAddress(),
        await created.quote.getAddress(),
        await core.quoteAdapter.getAddress(),
        created.catalogBinding,
        FACTORY_GENERATION,
        QUOTE_CAMPAIGN_GENERATION,
      );

    const scheduleEvents = await core.factory.queryFilter(core.factory.filters.ScheduledCampaignCreated());
    expect(scheduleEvents.length).to.equal(1);
    expect(scheduleEvents[0].args.factoryGeneration).to.equal(BigInt(FACTORY_GENERATION));
    expect(scheduleEvents[0].args.campaignGeneration).to.equal(BigInt(QUOTE_CAMPAIGN_GENERATION));

    const mutatedBinding = buildCatalogBinding(await created.quote.getAddress(), { policyVersion: 8 });
    await expect(core.factory.connect(core.creator).createBasicQuoteCampaignAuthorized(
      created.request,
      await created.quote.getAddress(),
      mutatedBinding,
      created.routeAuth,
    )).to.be.revertedWithCustomError(core.factory, "InvalidRouteAuthorization");

    await expect(core.factory.connect(core.creator).createBasicQuoteCampaignAuthorized(
      created.request,
      await created.quote.getAddress(),
      created.catalogBinding,
      created.routeAuth,
    )).to.be.revertedWithCustomError(core.factory, "RouteAuthorizationReplayed");
    expect(await core.factory.campaignsCount()).to.equal(1n);
  });

  it("graduates an approved stable quote permissionlessly and preserves locker fee economics", async function () {
    const core = await deployBnbBasicCore();
    const { quote, campaign, token } = await createQuoteCampaign(core);
    await crossThreshold(core, campaign);
    const raise = (await campaign.getGraduationState()).graduationBalance;

    await (await campaign.connect(core.other).graduate()).wait();

    expect(await campaign.launched()).to.equal(true);
    expect(await campaign.graduationPending()).to.equal(false);
    expect(await campaign.pendingCreatorGraduation()).to.equal((raise * 1980n) / BPS);
    const state = await campaign.getGraduationState();
    const pairAddress = state.dexPair;
    expect(pairAddress).to.equal(await core.topazFactory.getPool(await token.getAddress(), await quote.getAddress(), false));
    expect(await core.topazFactory.getPool(await token.getAddress(), await core.wbnb.getAddress(), false)).to.equal(ethers.ZeroAddress);

    const locker = core.locker;
    const principalBefore = await locker.lockedBalance(pairAddress);
    expect(principalBefore).to.be.gt(0n);
    expect((await locker.poolInfo(pairAddress)).pairedToken).to.equal(await quote.getAddress());

    const pair = await ethers.getContractAt("MockTopazPool", pairAddress);
    const feeAmount = E(100);
    await (await quote.approve(pairAddress, feeAmount)).wait();
    const token0 = await pair.token0();
    const quoteIs0 = token0.toLowerCase() === (await quote.getAddress()).toLowerCase();
    await (await pair.fundFees(await locker.getAddress(), quoteIs0 ? feeAmount : 0n, quoteIs0 ? 0n : feeAmount)).wait();

    const creatorBefore = await quote.balanceOf(await core.creator.getAddress());
    const protocolBefore = await quote.balanceOf(await core.protocolVault.getAddress());
    await (await locker.harvest(pairAddress)).wait();
    expect((await quote.balanceOf(await core.creator.getAddress())) - creatorBefore).to.equal((feeAmount * 8000n) / BPS);
    expect((await quote.balanceOf(await core.protocolVault.getAddress())) - protocolBefore).to.equal((feeAmount * 2000n) / BPS);
    expect(await locker.pendingProtocolToken(await quote.getAddress())).to.equal(0n);
    expect(await locker.lockedBalance(pairAddress)).to.equal(principalBefore);
  });

  it("keeps an unsafe quote pending with no native fallback, then graduates on deterministic recovery retry", async function () {
    const core = await deployBnbBasicCore();
    const { campaign, token, quote } = await createQuoteCampaign(core);
    await crossThreshold(core, campaign);
    const balanceBefore = await ethers.provider.getBalance(await campaign.getAddress());

    // The quote route refuses (here: the adapter reverts). Graduation reverts as a whole.
    await (await core.quoteAdapter.setBehaviour(true, false, 0, 0, 0, 0, false)).wait();
    await expect(campaign.connect(core.other).graduate()).to.be.revertedWith("adapter down");

    expect(await campaign.graduationPending()).to.equal(true);
    expect(await campaign.launched()).to.equal(false);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.equal(balanceBefore);
    expect(await core.topazFactory.getPool(await token.getAddress(), await quote.getAddress(), false)).to.equal(ethers.ZeroAddress);
    expect(await core.topazFactory.getPool(await token.getAddress(), await core.wbnb.getAddress(), false)).to.equal(ethers.ZeroAddress);
    // No native fallback: the native adapter was never called.
    expect(await core.nativeAdapter.calls()).to.equal(0n);

    await (await core.quoteAdapter.setBehaviour(false, false, 0, 0, 0, 0, false)).wait();
    await (await campaign.connect(core.other).graduate()).wait();

    expect(await campaign.graduationPending()).to.equal(false);
    expect(await campaign.launched()).to.equal(true);
    expect(await core.topazFactory.getPool(await token.getAddress(), await quote.getAddress(), false)).to.not.equal(ethers.ZeroAddress);
    expect(await core.topazFactory.getPool(await token.getAddress(), await core.wbnb.getAddress(), false)).to.equal(ethers.ZeroAddress);
    expect(await core.nativeAdapter.calls()).to.equal(0n);
  });
});
