import { expect } from "chai";
import { ethers } from "hardhat";
import { deployCoreFixture } from "./fixtures/core";

const TRADE_AUTH_BUY_EXACT_BNB = 1;

const req = (overrides: Record<string, unknown> = {}) => ({
  name: "SecureToken",
  symbol: "SEC",
  logoURI: "ipfs://logo",
  xAccount: "",
  website: "",
  extraLink: "",
  graduationTarget: 0n,
  firstBuyTokens: 0n,
  firstBuyMaxCost: 0n,
  feeChoice: 1,
  feeCreatorPct: 0,
  ...overrides,
});

async function deployRegistries(factory: any) {
  const CreatorRegistry = await ethers.getContractFactory("CreatorRegistry");
  const creatorRegistry = await CreatorRegistry.deploy();
  const RiskRegistry = await ethers.getContractFactory("RiskRegistry");
  const riskRegistry = await RiskRegistry.deploy();

  await creatorRegistry.setLaunchRecorder(await factory.getAddress(), true);
  await factory.setRegistries(await creatorRegistry.getAddress(), await riskRegistry.getAddress());

  return { creatorRegistry, riskRegistry };
}

async function createCampaign(factory: any, creator: any, overrides: Record<string, unknown> = {}) {
  await factory.connect(creator).createCampaign(req(overrides) as any);
  const info = await factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", await campaign.token());
  return { info, campaign, token };
}

describe("Phase 1 security layer", function () {
  it("records creator launches and enforces the 24h cooldown", async () => {
    const { factory, creator } = await deployCoreFixture();
    const { creatorRegistry } = await deployRegistries(factory);

    await factory.connect(creator).createCampaign(req({ name: "One", symbol: "ONE" }) as any);

    const profile = await creatorRegistry.getCreatorProfile(await creator.getAddress());
    expect(profile.liveBondingCount).to.eq(1n);

    await expect(
      factory.connect(creator).createCampaign(req({ name: "Two", symbol: "TWO" }) as any)
    ).to.be.revertedWithCustomError(factory, "CreatorNotEligible");
  });

  // EVM launch generation (C4): the tier buy lock is replaced by escrow. A creator buy is accepted but the tokens
  // are held by the campaign (nothing reaches the creator's wallet) and release from +30 days; the 24 h after launch
  // that the lock used to cover now has nothing claimable.
  it("blocks creator buys during the tier lock and allows them after lock expiry", async () => {
    const { factory, creator } = await deployCoreFixture();
    await deployRegistries(factory);
    const { campaign, token } = await createCampaign(factory, creator);
    const creatorAddr = await creator.getAddress();

    const quote = await campaign.quoteBuyExactBnb(ethers.parseEther("0.01"));
    await expect(campaign.connect(creator).buyExactBnb(0n, { value: ethers.parseEther("0.01") }))
      .to.emit(campaign, "CreatorBuyEscrowed")
      .and.to.emit(campaign, "TokensPurchased");
    const escrowed = await campaign.creatorEscrowTotal();
    expect(escrowed).to.be.gte(quote.tokensOut);
    expect(await token.balanceOf(creatorAddr)).to.eq(0n);
    expect(await token.balanceOf(await campaign.getAddress())).to.be.gte(escrowed);
    expect(await campaign.creatorBoughtWei()).to.be.gt(0n);

    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    await expect(campaign.connect(creator).buyExactBnb(0n, { value: ethers.parseEther("0.01") })).to.emit(
      campaign,
      "CreatorBuyEscrowed"
    );
    expect(await token.balanceOf(creatorAddr)).to.eq(0n);
    expect(await campaign.creatorEscrowClaimable()).to.eq(0n);
    await expect(campaign.connect(creator).claimCreatorEscrow()).to.be.revertedWithCustomError(campaign, "NothingToClaim");
  });

  it("enforces creator buy cap after the lock expires", async () => {
    // EVM launch generation: the fixture curve (the old 0.001/slope-1 curve with a $100 target is refused at
    // create: TargetOutOfRangeAtPrice). The NewCreator cap is 0.25 native of curve cost, excluding the fee.
    const { factory, creator } = await deployCoreFixture();
    const { creatorRegistry } = await deployRegistries(factory);
    const { campaign } = await createCampaign(factory, creator);
    const cap = (await creatorRegistry.getCreatorRules(await creator.getAddress())).creatorBuyCapWei;
    expect(await campaign.creatorBuyCapWei()).to.eq(cap);
    expect(cap).to.eq(ethers.parseEther("0.25"));

    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    await expect(
      campaign.connect(creator).buyExactBnb(0n, { value: ethers.parseEther("0.3") })
    ).to.be.revertedWithCustomError(campaign, "CreatorBuyCapExceeded");
    expect(await campaign.creatorBoughtWei()).to.eq(0n);

    // a buy that stays within the cap is accepted; a further buy past it is not
    const underCap = await campaign.quoteBuyExactBnb(ethers.parseEther("0.25"));
    expect(underCap.totalCostWei - underCap.feeWei).to.be.lte(cap);
    await campaign.connect(creator).buyExactBnb(0n, { value: ethers.parseEther("0.25") });
    expect(await campaign.creatorBoughtWei()).to.eq(underCap.totalCostWei - underCap.feeWei);
    await expect(
      campaign.connect(creator).buyExactBnb(0n, { value: ethers.parseEther("0.01") })
    ).to.be.revertedWithCustomError(campaign, "CreatorBuyCapExceeded");
  });

  it("blocks restricted wallets from buying and selling", async () => {
    const { factory, creator, alice } = await deployCoreFixture();
    const { riskRegistry } = await deployRegistries(factory);
    const { campaign } = await createCampaign(factory, creator);

    await riskRegistry.setWalletRisk(await alice.getAddress(), 1, true);

    await expect(
      campaign.connect(alice).buyExactBnb(0n, { value: ethers.parseEther("0.01") })
    ).to.be.revertedWithCustomError(riskRegistry, "WalletRestricted");
  });

  it("blocks creator launches when the creator cluster is above tier limits", async () => {
    const { factory, creator } = await deployCoreFixture();
    const { riskRegistry } = await deployRegistries(factory);
    const clusterId = ethers.id("creator-cluster-1");

    await riskRegistry.setWalletCluster(await creator.getAddress(), clusterId);
    await riskRegistry.setClusterRisk(clusterId, 4n, 0, false);

    await expect(factory.connect(creator).createCampaign(req() as any)).to.be.revertedWithCustomError(
      factory,
      "RiskNotEligible"
    );
  });

  it("enforces factory and campaign pause controls", async () => {
    const { factory, owner, creator, alice } = await deployCoreFixture();
    await deployRegistries(factory);

    await factory.connect(owner).setCreatePaused(true);
    await expect(factory.connect(creator).createCampaign(req() as any)).to.be.revertedWithCustomError(factory, "CreatePaused");
    await factory.connect(owner).setCreatePaused(false);

    const { campaign } = await createCampaign(factory, creator);
    await factory.connect(owner).setCampaignPauses(await campaign.getAddress(), false, true, false, false);

    await expect(
      campaign.connect(alice).buyExactBnb(0n, { value: ethers.parseEther("0.01") })
    ).to.be.revertedWithCustomError(campaign, "BuysPaused");
  });

  it("can require route-authorized trading for all direct buy and sell paths", async () => {
    const { factory, owner, creator, alice } = await deployCoreFixture();
    await factory.connect(owner).setRouteAuthority(await owner.getAddress());
    await factory.connect(owner).setRequireAuthorizedTrading(true);
    const { campaign } = await createCampaign(factory, creator);

    await expect(
      campaign.connect(alice).buyExactBnb(0n, { value: ethers.parseEther("0.01") })
    ).to.be.revertedWithCustomError(campaign, "AuthorizedTradingRequired");

    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 600);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const routeProfile = 1;
    const buyValue = ethers.parseEther("0.01");
    const minTokensOut = 0n;
    const digest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256", "address", "address", "uint8", "uint8", "uint256", "uint256", "uint64"],
        [
          "MWZ_ROUTE_TRADE_AUTH",
          chainId,
          await campaign.getAddress(),
          await alice.getAddress(),
          routeProfile,
          TRADE_AUTH_BUY_EXACT_BNB,
          buyValue,
          minTokensOut,
          deadline,
        ]
      )
    );
    const signature = await owner.signMessage(ethers.getBytes(digest));

    await expect(
      campaign.connect(alice).buyExactBnbAuthorized(minTokensOut, routeProfile, deadline, signature, {
        value: buyValue,
      })
    ).to.emit(campaign, "TokensPurchased");
  });

  it("records graduation and decrements creator live bonding count", async () => {
    const { factory, owner, creator, alice } = await deployCoreFixture();
    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000,
      liquidityTokenBps: 4000,
      basePrice: ethers.parseEther("0.005"),
      priceSlope: 10n ** 9n,
      graduationTarget: ethers.parseEther("0.005"),
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: 1,
      feeCreatorPct: 0,
      liquidityBps: 8000,
    });
    const { creatorRegistry } = await deployRegistries(factory);
    const { campaign } = await createCampaign(factory, creator);

    let profile = await creatorRegistry.getCreatorProfile(await creator.getAddress());
    expect(profile.liveBondingCount).to.eq(1n);

    // EVM launch generation (C5): the crossing buy only marks Pending; the campaign is still live bonding.
    await expect(campaign.connect(alice).buyExactBnb(0n, { value: ethers.parseEther("0.01") })).to.emit(
      campaign,
      "GraduationPending"
    );
    profile = await creatorRegistry.getCreatorProfile(await creator.getAddress());
    expect(await campaign.launched()).to.eq(false);
    expect(profile.liveBondingCount).to.eq(1n);

    // graduate() is permissionless; the factory records the graduation on the registry exactly once.
    await expect(campaign.connect(alice).graduate()).to.emit(factory, "CampaignGraduated");

    profile = await creatorRegistry.getCreatorProfile(await creator.getAddress());
    expect(await campaign.launched()).to.eq(true);
    expect(profile.liveBondingCount).to.eq(0n);
    expect(await factory.campaignGraduationRecorded(await campaign.getAddress())).to.eq(true);
  });
});
