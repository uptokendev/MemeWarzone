import { expect } from "chai";
import { ethers, network } from "hardhat";
import { deployCoreFixture } from "./fixtures/core";

const baseReq = (overrides: Record<string, unknown> = {}) => ({
  name: "LifecycleToken",
  symbol: "LIFE",
  logoURI: "ipfs://lifecycle-logo",
  xAccount: "",
  website: "",
  extraLink: "",
  basePrice: 0n,
  priceSlope: 0n,
  graduationTarget: 0n,
  lpReceiver: ethers.ZeroAddress,
  ...overrides,
});

async function increaseTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

async function deployRegistries() {
  const CreatorRegistry = await ethers.getContractFactory("CreatorRegistry");
  const creatorRegistry = await CreatorRegistry.deploy();
  await creatorRegistry.waitForDeployment();

  const RiskRegistry = await ethers.getContractFactory("RiskRegistry");
  const riskRegistry = await RiskRegistry.deploy();
  await riskRegistry.waitForDeployment();

  return { creatorRegistry, riskRegistry };
}

describe("LaunchFactory lifecycle integration", function () {
  it("global and create pauses are owner-only and gate new campaigns independently", async () => {
    const { factory, owner, creator, alice } = await deployCoreFixture();

    await expect(factory.connect(alice).setGlobalPaused(true)).to.be.revertedWithCustomError(
      factory,
      "OwnableUnauthorizedAccount"
    );
    await expect(factory.connect(alice).setCreatePaused(true)).to.be.revertedWithCustomError(
      factory,
      "OwnableUnauthorizedAccount"
    );

    await expect(factory.connect(owner).setGlobalPaused(true)).to.emit(factory, "GlobalPauseUpdated").withArgs(true);
    await expect(factory.connect(creator).createCampaign(baseReq() as any)).to.be.revertedWithCustomError(factory, "Paused");

    await factory.connect(owner).setGlobalPaused(false);
    await expect(factory.connect(owner).setCreatePaused(true)).to.emit(factory, "CreatePauseUpdated").withArgs(true);
    await expect(factory.connect(creator).createCampaign(baseReq() as any)).to.be.revertedWithCustomError(factory, "CreatePaused");

    await factory.connect(owner).setCreatePaused(false);
    await expect(factory.connect(creator).createCampaign(baseReq() as any)).to.emit(factory, "CampaignCreated");
  });

  it("route authority and registry pointers remain owner-only after factory lock", async () => {
    const { factory, owner, creator, alice } = await deployCoreFixture();
    const { creatorRegistry, riskRegistry } = await deployRegistries();

    await factory.connect(creator).createCampaign(baseReq() as any);

    await expect(factory.connect(alice).setRouteAuthority(await alice.getAddress())).to.be.revertedWithCustomError(
      factory,
      "OwnableUnauthorizedAccount"
    );
    await expect(factory.connect(alice).setRegistries(await creatorRegistry.getAddress(), await riskRegistry.getAddress())).to.be.revertedWithCustomError(
      factory,
      "OwnableUnauthorizedAccount"
    );

    await expect(factory.connect(owner).setRouteAuthority(await alice.getAddress()))
      .to.emit(factory, "RouteAuthorityUpdated")
      .withArgs(await alice.getAddress());
    await expect(factory.connect(owner).setRegistries(await creatorRegistry.getAddress(), await riskRegistry.getAddress()))
      .to.emit(factory, "RegistriesUpdated")
      .withArgs(await creatorRegistry.getAddress(), await riskRegistry.getAddress());

    expect(await factory.routeAuthority()).to.eq(await alice.getAddress());
    expect(await factory.creatorRegistry()).to.eq(await creatorRegistry.getAddress());
    expect(await factory.riskRegistry()).to.eq(await riskRegistry.getAddress());
  });

  it("campaign paging handles empty state, zero limit, and multi-page reads", async () => {
    const { factory, creator, alice, bob } = await deployCoreFixture();

    const initiallyEmpty = await factory.getCampaignPage(0n, 0n);
    expect(initiallyEmpty.length).to.eq(0);

    await factory.connect(creator).createCampaign(baseReq({ name: "Life One", symbol: "LIF1" }) as any);
    await factory.connect(alice).createCampaign(baseReq({ name: "Life Two", symbol: "LIF2" }) as any);
    await factory.connect(bob).createCampaign(baseReq({ name: "Life Three", symbol: "LIF3" }) as any);

    const emptyPage = await factory.getCampaignPage(0n, 0n);
    expect(emptyPage.length).to.eq(0);

    const middlePage = await factory.getCampaignPage(1n, 2n);
    expect(middlePage.length).to.eq(2);
    expect(middlePage[0].name).to.eq("Life Two");
    expect(middlePage[1].name).to.eq("Life Three");

    const tailPage = await factory.getCampaignPage(2n, 10n);
    expect(tailPage.length).to.eq(1);
    expect(tailPage[0].symbol).to.eq("LIF3");
  });

  it("creator registry records launches and injects creator buy protections into campaigns", async () => {
    const { factory, owner, creator } = await deployCoreFixture();
    const { creatorRegistry, riskRegistry } = await deployRegistries();

    await creatorRegistry.setLaunchRecorder(await factory.getAddress(), true);
    await factory.connect(owner).setRegistries(await creatorRegistry.getAddress(), await riskRegistry.getAddress());

    await expect(factory.connect(creator).createCampaign(baseReq({ name: "Registry Life", symbol: "REGL" }) as any)).to.emit(
      creatorRegistry,
      "CreatorLaunchRecorded"
    );

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const rules = await creatorRegistry.getCreatorRules(await creator.getAddress());
    const profile = await creatorRegistry.getCreatorProfile(await creator.getAddress());

    expect(profile.liveBondingCount).to.eq(1n);
    expect(await campaign.creatorBuyCapWei()).to.eq(rules.creatorBuyCapWei);
    expect(await campaign.creatorBuyLockUntil()).to.be.gt(0n);

    const amountOut = ethers.parseEther("1");
    const total = await campaign.quoteBuyExactTokens(amountOut);
    await expect(campaign.connect(creator).buyExactTokens(amountOut, total, { value: total })).to.be.revertedWithCustomError(
      campaign,
      "CreatorBuyLocked"
    );
  });

  it("creator registry blocks restricted, manual-review, cooldown, and live-limit launches through the factory", async () => {
    const { factory, owner, creator } = await deployCoreFixture();
    const { creatorRegistry, riskRegistry } = await deployRegistries();
    const creatorAddress = await creator.getAddress();

    await creatorRegistry.setLaunchRecorder(await factory.getAddress(), true);
    await factory.connect(owner).setRegistries(await creatorRegistry.getAddress(), await riskRegistry.getAddress());

    await creatorRegistry.setCreatorRestricted(creatorAddress, true);
    await expect(factory.connect(creator).createCampaign(baseReq({ name: "Restricted", symbol: "RST" }) as any)).to.be.revertedWithCustomError(
      factory,
      "CreatorNotEligible"
    );

    await creatorRegistry.setCreatorRestricted(creatorAddress, false);
    await creatorRegistry.setManualReviewRequired(creatorAddress, true);
    await expect(factory.connect(creator).createCampaign(baseReq({ name: "Manual", symbol: "MAN" }) as any)).to.be.revertedWithCustomError(
      factory,
      "CreatorNotEligible"
    );

    await creatorRegistry.setManualReviewRequired(creatorAddress, false);
    await factory.connect(creator).createCampaign(baseReq({ name: "First", symbol: "ONE" }) as any);
    await expect(factory.connect(creator).createCampaign(baseReq({ name: "Cooldown", symbol: "CDN" }) as any)).to.be.revertedWithCustomError(
      factory,
      "CreatorNotEligible"
    );

    await increaseTime(24 * 60 * 60 + 1);
    await factory.connect(creator).createCampaign(baseReq({ name: "Second", symbol: "TWO" }) as any);
    await increaseTime(24 * 60 * 60 + 1);
    await factory.connect(creator).createCampaign(baseReq({ name: "Third", symbol: "THR" }) as any);
    await increaseTime(24 * 60 * 60 + 1);
    await expect(factory.connect(creator).createCampaign(baseReq({ name: "Fourth", symbol: "FOU" }) as any)).to.be.revertedWithCustomError(
      factory,
      "CreatorNotEligible"
    );
  });

  it("risk registry blocks restricted creators and oversized clusters through the factory", async () => {
    const { factory, owner, creator } = await deployCoreFixture();
    const { creatorRegistry, riskRegistry } = await deployRegistries();
    const creatorAddress = await creator.getAddress();
    const clusterId = ethers.keccak256(ethers.toUtf8Bytes("factory-risk-cluster"));

    await creatorRegistry.setLaunchRecorder(await factory.getAddress(), true);
    await factory.connect(owner).setRegistries(await creatorRegistry.getAddress(), await riskRegistry.getAddress());

    await riskRegistry.setWalletRisk(creatorAddress, 10, true);
    await expect(factory.connect(creator).createCampaign(baseReq({ name: "Risky", symbol: "RSK" }) as any)).to.be.revertedWithCustomError(
      factory,
      "RiskNotEligible"
    );

    await riskRegistry.setWalletRisk(creatorAddress, 0, false);
    await riskRegistry.setWalletCluster(creatorAddress, clusterId);
    await riskRegistry.setClusterRisk(clusterId, 4, 1, false);
    await expect(factory.connect(creator).createCampaign(baseReq({ name: "Clustered", symbol: "CLS" }) as any)).to.be.revertedWithCustomError(
      factory,
      "RiskNotEligible"
    );

    await riskRegistry.setClusterRisk(clusterId, 3, 1, false);
    await expect(factory.connect(creator).createCampaign(baseReq({ name: "Allowed", symbol: "ALW" }) as any)).to.emit(
      factory,
      "CampaignCreated"
    );
  });

  it("graduation notification decrements creator live count and registers the LP token", async () => {
    const { factory, owner, creator, alice, permanentLpLocker, router } = await deployCoreFixture();
    const { creatorRegistry, riskRegistry } = await deployRegistries();
    const creatorAddress = await creator.getAddress();
    const MockPhase1TreasuryRouter = await ethers.getContractFactory("MockPhase1TreasuryRouter");
    const strictFeeRouter = await MockPhase1TreasuryRouter.deploy();
    await strictFeeRouter.waitForDeployment();

    await factory.connect(owner).setCoreRouting(await router.getAddress(), await strictFeeRouter.getAddress());
    await creatorRegistry.setLaunchRecorder(await factory.getAddress(), true);
    await factory.connect(owner).setRegistries(await creatorRegistry.getAddress(), await riskRegistry.getAddress());
    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000,
      liquidityTokenBps: 4000,
      basePrice: 10n ** 12n,
      priceSlope: 10n ** 9n,
      graduationTarget: 1n,
      liquidityBps: 8000,
    });

    await factory.connect(creator).createCampaign(baseReq({ name: "Graduate Life", symbol: "GRAD" }) as any);
    expect((await creatorRegistry.getCreatorProfile(creatorAddress)).liveBondingCount).to.eq(1n);

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);

    await expect(campaign.connect(alice).buyExactTokens(curveSupply, totalBuy, { value: totalBuy })).to.emit(
      factory,
      "CampaignGraduated"
    );

    const state = await campaign.getGraduationState();
    expect(state.dexPair).to.not.eq(ethers.ZeroAddress);
    expect(await permanentLpLocker.registeredLpToken(state.dexPair)).to.eq(true);
    expect((await creatorRegistry.getCreatorProfile(creatorAddress)).liveBondingCount).to.eq(0n);
  });

  it("unknown graduation notifications do not mutate creator registry state", async () => {
    const { factory, owner, creator, alice } = await deployCoreFixture();
    const { creatorRegistry, riskRegistry } = await deployRegistries();

    await creatorRegistry.setLaunchRecorder(await factory.getAddress(), true);
    await factory.connect(owner).setRegistries(await creatorRegistry.getAddress(), await riskRegistry.getAddress());

    await expect(factory.connect(alice).notifyCampaignGraduated(await creator.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(
      factory,
      "UnknownCampaign"
    );
    expect((await creatorRegistry.getCreatorProfile(await creator.getAddress())).liveBondingCount).to.eq(0n);
  });
});