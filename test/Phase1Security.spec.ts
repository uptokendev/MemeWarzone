import { expect } from "chai";
import { ethers } from "hardhat";
import { completeNativeGraduation, deployCoreFixture } from "./fixtures/core";

const TRADE_AUTH_BUY_EXACT_BNB = 1;

const req = (overrides: Record<string, unknown> = {}) => ({
  name: "SecureToken",
  symbol: "SEC",
  logoURI: "ipfs://logo",
  xAccount: "",
  website: "",
  extraLink: "",
  basePrice: 0n,
  priceSlope: 0n,
  graduationTarget: 0n,
  lpReceiver: ethers.ZeroAddress,
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

  it("blocks creator buys during the tier lock and allows them after lock expiry", async () => {
    const { factory, creator } = await deployCoreFixture();
    await deployRegistries(factory);
    const { campaign } = await createCampaign(factory, creator);

    await expect(
      campaign.connect(creator).buyExactBnb(0n, { value: ethers.parseEther("0.01") })
    ).to.be.revertedWithCustomError(campaign, "CreatorBuyLocked");

    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    await expect(campaign.connect(creator).buyExactBnb(0n, { value: ethers.parseEther("0.01") })).to.emit(
      campaign,
      "TokensPurchased"
    );
    expect(await campaign.creatorBoughtWei()).to.be.gt(0n);
  });

  it("enforces creator buy cap after the lock expires", async () => {
    const { factory, owner, creator } = await deployCoreFixture();
    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000,
      liquidityTokenBps: 4000,
      basePrice: ethers.parseEther("0.001"),
      priceSlope: 1n,
      graduationTarget: ethers.parseEther("100"),
      liquidityBps: 8000,
    });
    await deployRegistries(factory);
    const { campaign } = await createCampaign(factory, creator);

    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);

    await expect(
      campaign.connect(creator).buyExactBnb(0n, { value: ethers.parseEther("0.3") })
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
      liquidityBps: 8000,
    });
    const { creatorRegistry } = await deployRegistries(factory);
    const { campaign } = await createCampaign(factory, creator);

    let profile = await creatorRegistry.getCreatorProfile(await creator.getAddress());
    expect(profile.liveBondingCount).to.eq(1n);

    await campaign.connect(alice).buyExactBnb(0n, { value: ethers.parseEther("0.01") });
    await completeNativeGraduation(campaign, alice);

    profile = await creatorRegistry.getCreatorProfile(await creator.getAddress());
    expect(await campaign.launched()).to.eq(true);
    expect(profile.liveBondingCount).to.eq(0n);
  });
});
