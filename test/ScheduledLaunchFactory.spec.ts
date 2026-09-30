import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { ethers, network } from "hardhat";
import { deployScheduledCreateFixture, signScheduledCreateAuthorization } from "./helpers/legacy-B1";

const baseCampaign = (overrides: Record<string, unknown> = {}) => ({
  name: "Scheduled Token",
  symbol: "SCH",
  logoURI: "ipfs://scheduled-logo",
  xAccount: "scheduled",
  website: "https://example.test",
  extraLink: "",
  graduationTarget: 0n,
  firstBuyTokens: 0n,
  firstBuyMaxCost: 0n,
  feeChoice: 1,
  feeCreatorPct: 0,
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
  const { factory, owner, creator, priceFeed } = fixture;
  await factory.connect(owner).setRouteAuthority(await owner.getAddress());

  // Launch generation: create refuses a USD target above 95% of what the full curve raises at the oracle
  // price. The fixture's tiny curve raises ~1.25 native, i.e. $1.25 at the fixture's $1 oracle, so the $6
  // test target runs on the generation's production V2 curve with native at $600 ($6 = 0.01 native).
  await factory.connect(owner).setConfig({
    totalSupply: ethers.parseEther("1000000000"),
    curveBps: 7000n,
    liquidityTokenBps: 2800n,
    basePrice: 1_000_000_000n,
    priceSlope: 1080n,
    graduationTarget: ethers.parseEther("6"),
  });
  const nowTs = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  await priceFeed.setRoundData(2n, ethers.parseUnits("600", 8), nowTs, nowTs, 2n);

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
    // Launch generation: the creator buy lock (creatorBuyLockUntil) is replaced by C4 escrow and the C2
    // anti-sniper fee; what stays launch-anchored is the fee clock (5000 bps at launchAt -> 200 at +60 s),
    // never the deploy time.
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
    // The fixture has no CreatorRegistry, so no tier cap is injected.
    expect(await campaign.creatorBuyCapWei()).to.equal(0n);
    // Before launchAt the view reports the start value; the window runs from launchAt, not from deploy.
    expect(await campaign.currentTradeFeeBps()).to.equal(5000n);
    await network.provider.send("evm_setNextBlockTimestamp", [Number(launchAt) + 30]);
    await network.provider.send("evm_mine");
    expect(await campaign.currentTradeFeeBps()).to.equal(5000n - 80n * 30n);
    await network.provider.send("evm_setNextBlockTimestamp", [Number(launchAt) + 60]);
    await network.provider.send("evm_mine");
    expect(await campaign.currentTradeFeeBps()).to.equal(200n);
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