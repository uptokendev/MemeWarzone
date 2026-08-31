import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { ethers, network } from "hardhat";
import { deployScheduledCreateFixture, signScheduledCreateAuthorization } from "./helpers/scheduledCreateAuth";

const baseCampaign = (overrides: Record<string, unknown> = {}) => ({
  name: "Scheduled Token",
  symbol: "SCH",
  logoURI: "ipfs://scheduled-logo",
  xAccount: "scheduled",
  website: "https://example.test",
  extraLink: "",
  graduationTarget: 0n,
  ...overrides,
});

async function signScheduledCreate(
  factory: any,
  creator: string,
  signer: any,
  request: any,
  tradeRouteProfile: number,
  finalizeRouteProfile: number,
  deadline: bigint,
) {
  return signScheduledCreateAuthorization(
    factory,
    creator,
    signer,
    request,
    tradeRouteProfile,
    finalizeRouteProfile,
    deadline,
  );
}

async function scheduledFixture() {
  const fixture = await deployScheduledCreateFixture();
  const { factory, owner, creator } = fixture;
  await factory.connect(owner).setRouteAuthority(await owner.getAddress());

  const current = await factory.config();
  await factory.connect(owner).setConfig({
    totalSupply: current.totalSupply,
    curveBps: current.curveBps,
    liquidityTokenBps: current.liquidityTokenBps,
    basePrice: current.basePrice,
    priceSlope: current.priceSlope,
    graduationTarget: ethers.parseEther("6"),
    liquidityBps: current.liquidityBps,
  });

  const latest = await ethers.provider.getBlock("latest");
  const launchAt = BigInt(latest!.timestamp + 3600);
  const request = {
    campaign: baseCampaign(),
    launchAt,
    draftReferenceHash: ethers.id("draft-123"),
    normalizedTickerHash: ethers.id("SCH"),
    metadataHash: ethers.id("metadata-v1"),
    reservationVersion: 1n,
    authorizationNonce: 1n,
  };
  const deadline = launchAt + 3600n;
  const signature = await signScheduledCreate(
    factory,
    await creator.getAddress(),
    owner,
    request,
    1,
    1,
    deadline,
  );
  const authorization = {
    tradeRouteProfile: 1,
    finalizeRouteProfile: 1,
    deadline,
    signature,
  };

  return { ...fixture, request, authorization, launchAt };
}

describe("Scheduled LaunchFactory generation", function () {
  it("persists bound schedule evidence, fixed test graduation target, and launch-anchored creator lock", async () => {
    const { factory, creator, request, authorization, launchAt } = await scheduledFixture();
    const creatorAddress = await creator.getAddress();

    const factoryGeneration = await factory.FACTORY_GENERATION();
    const campaignGeneration = await factory.CAMPAIGN_GENERATION();
    const tx = factory.connect(creator).createScheduledCampaignAuthorized(request, authorization);
    await expect(tx)
      .to.emit(factory, "ScheduledCampaignCreated")
      .withArgs(
        0n,
        anyValue,
        anyValue,
        creatorAddress,
        launchAt,
        request.draftReferenceHash,
        request.normalizedTickerHash,
        request.metadataHash,
        1n,
        1n,
        factoryGeneration,
        campaignGeneration,
      );

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);

    expect(await campaign.launchAt()).to.equal(launchAt);
    expect(await campaign.graduationTarget()).to.equal(ethers.parseEther("6"));
    // The fixture has no CreatorRegistry, so creatorBuyLockSeconds=0. This makes
    // the exact anchor observable: scheduled deploy time must not be used here.
    expect(await campaign.creatorBuyLockUntil()).to.equal(launchAt);
    expect(await factory.usedAuthorizationNonces(creatorAddress, 1n)).to.equal(true);
  });

  it("blocks trading before launchAt and opens without a second transaction", async () => {
    const { factory, creator, alice, request, authorization, launchAt } = await scheduledFixture();
    await factory.connect(creator).createScheduledCampaignAuthorized(request, authorization);

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const amountOut = ethers.parseEther("1");
    const quote = await campaign.quoteBuyExactTokens(amountOut);

    await expect(
      campaign.connect(alice).buyExactTokens(amountOut, quote, { value: quote }),
    ).to.be.revertedWithCustomError(campaign, "TradingNotOpen");

    await network.provider.send("evm_setNextBlockTimestamp", [Number(launchAt)]);
    await network.provider.send("evm_mine");

    await expect(campaign.connect(alice).buyExactTokens(amountOut, quote, { value: quote }))
      .to.emit(campaign, "TokensPurchased");
  });

  it("rejects authorization replay, nonce replay, and tampered schedule bindings", async () => {
    const { factory, creator, request, authorization } = await scheduledFixture();
    await factory.connect(creator).createScheduledCampaignAuthorized(request, authorization);

    await expect(
      factory.connect(creator).createScheduledCampaignAuthorized(request, authorization),
    ).to.be.revertedWithCustomError(factory, "RouteAuthorizationReplayed");

    const latest = await ethers.provider.getBlock("latest");
    const secondRequest = {
      ...request,
      launchAt: BigInt(latest!.timestamp + 7200),
      metadataHash: ethers.id("metadata-v2"),
    };
    const secondDeadline = secondRequest.launchAt + 3600n;
    const secondSignature = await signScheduledCreate(
      factory,
      await creator.getAddress(),
      (await ethers.getSigners())[0],
      secondRequest,
      1,
      1,
      secondDeadline,
    );

    await expect(
      factory.connect(creator).createScheduledCampaignAuthorized(secondRequest, {
        tradeRouteProfile: 1,
        finalizeRouteProfile: 1,
        deadline: secondDeadline,
        signature: secondSignature,
      }),
    ).to.be.revertedWithCustomError(factory, "RouteAuthorizationReplayed");

    const tampered = { ...secondRequest, authorizationNonce: 2n, metadataHash: ethers.id("tampered") };
    await expect(
      factory.connect(creator).createScheduledCampaignAuthorized(tampered, {
        tradeRouteProfile: 1,
        finalizeRouteProfile: 1,
        deadline: secondDeadline,
        signature: secondSignature,
      }),
    ).to.be.revertedWithCustomError(factory, "InvalidRouteAuthorization");
  });

  it("rejects incomplete and overlong schedules", async () => {
    const { factory, creator, owner, request } = await scheduledFixture();
    const latest = await ethers.provider.getBlock("latest");
    const tooFar = { ...request, launchAt: BigInt(latest!.timestamp) + 31n * 24n * 60n * 60n };
    const deadline = tooFar.launchAt + 3600n;
    const signature = await signScheduledCreate(factory, await creator.getAddress(), owner, tooFar, 1, 1, deadline);

    await expect(
      factory.connect(creator).createScheduledCampaignAuthorized(tooFar, {
        tradeRouteProfile: 1,
        finalizeRouteProfile: 1,
        deadline,
        signature,
      }),
    ).to.be.revertedWithCustomError(factory, "LaunchAtTooFar");

    const missingTicker = { ...request, normalizedTickerHash: ethers.ZeroHash };
    const missingDeadline = request.launchAt + 3600n;
    const missingSignature = await signScheduledCreate(
      factory,
      await creator.getAddress(),
      owner,
      missingTicker,
      1,
      1,
      missingDeadline,
    );
    await expect(
      factory.connect(creator).createScheduledCampaignAuthorized(missingTicker, {
        tradeRouteProfile: 1,
        finalizeRouteProfile: 1,
        deadline: missingDeadline,
        signature: missingSignature,
      }),
    ).to.be.revertedWithCustomError(factory, "MissingTickerHash");
  });
});