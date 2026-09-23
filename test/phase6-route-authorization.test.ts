import { expect } from "chai";
import { ethers } from "hardhat";
import { deployRoutedLaunchFactory } from "./helpers/deployRouting";

const STANDARD_LINKED = 0;
const STANDARD_UNLINKED = 1;
const OG_LINKED = 2;
const TRADE_AUTH_BUY_EXACT_TOKENS = 0;

async function signerHelpers() {
  return import("../frontend/api/dev-fix/routeAuthorizationSigner.js");
}

async function currentDeadline(offset = 3600) {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("missing latest block");
  return BigInt(block.timestamp + offset);
}

async function deployFixture() {
  const [admin, routeAuthority, creator, trader] = await ethers.getSigners();
  const { factory, treasuryRouter: treasury } = await deployRoutedLaunchFactory(admin);
  await factory.connect(admin).setRouteAuthority(routeAuthority.address);
  await factory.connect(admin).enableLive();

  const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
  const request = {
    name: "MemeWarzone Test",
    symbol: "MWZT",
    logoURI: "ipfs://logo",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: 0n,
  };

  return { admin, routeAuthority, creator, trader, factory, treasury, chainId, request };
}

async function signCreateRouteAuth({ signer, chainId, factory, creator, request, tradeRouteProfile, finalizeRouteProfile, deadline }: any) {
  const { signCreateAuthorization } = await signerHelpers();
  return signCreateAuthorization({
    signer,
    chainId,
    factoryAddress: factory,
    creator,
    request,
    tradeRouteProfileId: tradeRouteProfile,
    finalizeRouteProfileId: finalizeRouteProfile,
    deadline,
  });
}

async function signTradeRouteAuth({ signer, chainId, campaign, actor, routeProfile, action, amount, limit, deadline }: any) {
  const { signTradeAuthorization } = await signerHelpers();
  return signTradeAuthorization({
    signer,
    chainId,
    campaignAddress: campaign,
    actor,
    routeProfileId: routeProfile,
    action,
    amount,
    limit,
    deadline,
  });
}

async function createAuthorizedCampaign(fixture: Awaited<ReturnType<typeof deployFixture>>, tradeProfile: number, finalizeProfile: number) {
  const { creator, routeAuthority, factory, chainId, request } = fixture;
  const deadline = await currentDeadline();
  const signature = await signCreateRouteAuth({
    signer: routeAuthority,
    chainId,
    factory: await factory.getAddress(),
    creator: creator.address,
    request,
    tradeRouteProfile: tradeProfile,
    finalizeRouteProfile: finalizeProfile,
    deadline,
  });

  const tx = await factory.connect(creator).createCampaignAuthorized(request, {
    tradeRouteProfile: tradeProfile,
    finalizeRouteProfile: finalizeProfile,
    deadline,
    signature,
  });
  const receipt = await tx.wait();
  if (!receipt) throw new Error("missing receipt");

  const event = receipt.logs
    .map((log: any) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed: any) => parsed?.name === "CampaignCreated");
  if (!event) throw new Error("CampaignCreated not found");

  expect(event.args.logoURI).to.equal(request.logoURI);
  expect(event.args.metadataURI).to.equal("");

  const campaignAddress = event.args.campaign;
  const campaign = await ethers.getContractAt("LaunchCampaign", campaignAddress);
  return { campaign, campaignAddress };
}

describe("Phase 6 route authorization alignment", function () {
  it("uses the backend route-profile ID order in factory and treasury", async function () {
    const { factory, treasury } = await deployFixture();

    expect(await factory.ROUTE_PROFILE_STANDARD_LINKED()).to.equal(STANDARD_LINKED);
    expect(await factory.ROUTE_PROFILE_STANDARD_UNLINKED()).to.equal(STANDARD_UNLINKED);
    expect(await factory.ROUTE_PROFILE_OG_LINKED()).to.equal(OG_LINKED);

    // [league, creator, recruiter, airdrop, squad, protocol] -- the creator share
    // is 5% of a trade fee on TreasuryRouterV3, taken from the protocol's.
    expect(await treasury.previewRoute(10_000n, 0, STANDARD_LINKED)).to.deep.equal([3750n, 500n, 1250n, 0n, 250n, 4250n]);
    expect(await treasury.previewRoute(10_000n, 0, STANDARD_UNLINKED)).to.deep.equal([3750n, 500n, 0n, 1500n, 0n, 4250n]);
    expect(await treasury.previewRoute(10_000n, 0, OG_LINKED)).to.deep.equal([3750n, 500n, 1500n, 0n, 250n, 4000n]);
  });

  for (const [label, tradeProfile, finalizeProfile] of [
    ["StandardLinked", STANDARD_LINKED, STANDARD_LINKED],
    ["StandardUnlinked", STANDARD_UNLINKED, STANDARD_UNLINKED],
    ["OgLinked", OG_LINKED, OG_LINKED],
  ] as const) {
    it(`creates an authorized campaign with ${label} route profiles`, async function () {
      const fixture = await deployFixture();
      const { campaign } = await createAuthorizedCampaign(fixture, tradeProfile, finalizeProfile);
      expect(await campaign.tradeRouteProfile()).to.equal(tradeProfile);
      expect(await campaign.finalizeRouteProfile()).to.equal(finalizeProfile);
    });
  }

  it("rejects create authorization from the wrong signer", async function () {
    const fixture = await deployFixture();
    const { creator, trader, factory, chainId, request } = fixture;
    const deadline = await currentDeadline();
    const signature = await signCreateRouteAuth({
      signer: trader,
      chainId,
      factory: await factory.getAddress(),
      creator: creator.address,
      request,
      tradeRouteProfile: OG_LINKED,
      finalizeRouteProfile: OG_LINKED,
      deadline,
    });

    await expect(
      factory.connect(creator).createCampaignAuthorized(request, {
        tradeRouteProfile: OG_LINKED,
        finalizeRouteProfile: OG_LINKED,
        deadline,
        signature,
      }),
    ).to.be.revertedWithCustomError(factory, "InvalidRouteAuthorization");
  });

  it("rejects expired create authorization", async function () {
    const fixture = await deployFixture();
    const { creator, routeAuthority, factory, chainId, request } = fixture;
    const block = await ethers.provider.getBlock("latest");
    if (!block) throw new Error("missing latest block");
    const deadline = BigInt(block.timestamp - 1);
    const signature = await signCreateRouteAuth({
      signer: routeAuthority,
      chainId,
      factory: await factory.getAddress(),
      creator: creator.address,
      request,
      tradeRouteProfile: OG_LINKED,
      finalizeRouteProfile: OG_LINKED,
      deadline,
    });

    await expect(
      factory.connect(creator).createCampaignAuthorized(request, {
        tradeRouteProfile: OG_LINKED,
        finalizeRouteProfile: OG_LINKED,
        deadline,
        signature,
      }),
    ).to.be.revertedWithCustomError(factory, "RouteAuthorizationExpired");
  });

  it("routes authorized buy fees with the provided trade route profile", async function () {
    const fixture = await deployFixture();
    const { trader, routeAuthority, treasury, chainId } = fixture;
    const { campaign, campaignAddress } = await createAuthorizedCampaign(fixture, STANDARD_UNLINKED, STANDARD_UNLINKED);

    const amountOut = ethers.parseEther("1000");
    const maxCost = await campaign.quoteBuyExactTokens(amountOut);
    const protocolFeeBps = await campaign.protocolFeeBps();
    const feeAmount = (maxCost * protocolFeeBps) / (10_000n + protocolFeeBps);
    const routeAmounts = await treasury.previewRoute(feeAmount, 0, OG_LINKED);
    const deadline = await currentDeadline();
    const signature = await signTradeRouteAuth({
      signer: routeAuthority,
      chainId,
      campaign: campaignAddress,
      actor: trader.address,
      routeProfile: OG_LINKED,
      action: TRADE_AUTH_BUY_EXACT_TOKENS,
      amount: amountOut,
      limit: maxCost,
      deadline,
    });

    await expect(
      campaign.connect(trader).buyExactTokensAuthorized(amountOut, maxCost, OG_LINKED, deadline, signature, { value: maxCost }),
    )
      .to.emit(treasury, "RouteExecuted")
      .withArgs(
        0,
        OG_LINKED,
        await campaign.getAddress(),
        feeAmount,
        routeAmounts.league,
        routeAmounts.creator,
        routeAmounts.recruiter,
        routeAmounts.airdrop,
        routeAmounts.squad,
        routeAmounts.protocol,
      );
  });

  it("rejects trade authorization when amount intent changes", async function () {
    const fixture = await deployFixture();
    const { trader, routeAuthority, chainId } = fixture;
    const { campaign, campaignAddress } = await createAuthorizedCampaign(fixture, STANDARD_UNLINKED, STANDARD_UNLINKED);

    const amountOut = ethers.parseEther("1000");
    const tamperedAmountOut = ethers.parseEther("1001");
    const maxCost = await campaign.quoteBuyExactTokens(amountOut);
    const tamperedMaxCost = await campaign.quoteBuyExactTokens(tamperedAmountOut);
    const deadline = await currentDeadline();
    const signature = await signTradeRouteAuth({
      signer: routeAuthority,
      chainId,
      campaign: campaignAddress,
      actor: trader.address,
      routeProfile: OG_LINKED,
      action: TRADE_AUTH_BUY_EXACT_TOKENS,
      amount: amountOut,
      limit: maxCost,
      deadline,
    });

    await expect(
      campaign.connect(trader).buyExactTokensAuthorized(tamperedAmountOut, tamperedMaxCost, OG_LINKED, deadline, signature, {
        value: tamperedMaxCost,
      }),
    ).to.be.revertedWithCustomError(campaign, "BadRouteAuth");
  });

  it("rejects trade authorization for the wrong actor", async function () {
    const fixture = await deployFixture();
    const { trader, creator, routeAuthority, chainId } = fixture;
    const { campaign, campaignAddress } = await createAuthorizedCampaign(fixture, STANDARD_UNLINKED, STANDARD_UNLINKED);

    const amountOut = ethers.parseEther("1000");
    const maxCost = await campaign.quoteBuyExactTokens(amountOut);
    const deadline = await currentDeadline();
    const signature = await signTradeRouteAuth({
      signer: routeAuthority,
      chainId,
      campaign: campaignAddress,
      actor: creator.address,
      routeProfile: STANDARD_LINKED,
      action: TRADE_AUTH_BUY_EXACT_TOKENS,
      amount: amountOut,
      limit: maxCost,
      deadline,
    });

    await expect(
      campaign.connect(trader).buyExactTokensAuthorized(amountOut, maxCost, STANDARD_LINKED, deadline, signature, { value: maxCost }),
    ).to.be.revertedWithCustomError(campaign, "BadRouteAuth");
  });
});
