import { expect } from "chai";
import { ethers } from "hardhat";

async function nowTs() {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
}

async function setFeed(feed: any, value: bigint, decimals = 8, updatedAt?: bigint) {
  const now = updatedAt ?? (await nowTs());
  const scaled = value * (10n ** BigInt(decimals));
  await (await feed.setRoundData(1, scaled, now, now, 1)).wait();
}

async function deployNativeCore() {
  const [owner, creator, buyer] = await ethers.getSigners();

  const Wbnb = await ethers.getContractFactory("MockWBNB");
  const wbnb = await Wbnb.deploy();
  await wbnb.waitForDeployment();

  const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
  const topazFactory = await TopazFactory.deploy();
  await topazFactory.waitForDeployment();

  const Router = await ethers.getContractFactory("MockBnbQuoteTopazRouter");
  const router = await Router.deploy(await topazFactory.getAddress(), await wbnb.getAddress());
  await router.waitForDeployment();

  const Treasury = await ethers.getContractFactory("MockPhase1TreasuryRouter");
  const treasury = await Treasury.deploy();
  await treasury.waitForDeployment();

  const Feed = await ethers.getContractFactory("MockUsdPriceFeed");
  const nativeFeed = await Feed.deploy(8);
  await nativeFeed.waitForDeployment();
  await setFeed(nativeFeed, 600n);

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const graduationOracle = await GraduationOracle.deploy(await nativeFeed.getAddress(), 3600);
  await graduationOracle.waitForDeployment();

  const NativeCampaign = await ethers.getContractFactory("LaunchCampaign");
  const nativeImpl = await NativeCampaign.deploy();
  await nativeImpl.waitForDeployment();

  const QuoteCampaign = await ethers.getContractFactory("BnbQuoteLaunchCampaign");
  const quoteImpl = await QuoteCampaign.deploy();
  await quoteImpl.waitForDeployment();

  const BasicFactory = await ethers.getContractFactory("BnbBasicLaunchFactory");
  const factory = await BasicFactory.deploy(
    await router.getAddress(),
    await treasury.getAddress(),
    await nativeImpl.getAddress(),
    await graduationOracle.getAddress(),
    await quoteImpl.getAddress(),
  );
  await factory.waitForDeployment();

  await (await factory.setConfig({
    totalSupply: ethers.parseEther("1000000000"),
    curveBps: 8400,
    liquidityTokenBps: 1400,
    basePrice: 1_000_000_000n,
    priceSlope: 850n,
    graduationTarget: ethers.parseEther("60"),
    liquidityBps: 3300,
  })).wait();
  await (await factory.setProtocolFee(200)).wait();
  await (await factory.setRequireAuthorizedTrading(false)).wait();
  await (await factory.setRequireRouteAuthorization(false)).wait();
  await (await factory.setRouteAuthority(await owner.getAddress())).wait();
  await (await factory.enableLive()).wait();

  const req = {
    name: "Native Meme",
    symbol: "NATIVE",
    logoURI: "ipfs://native",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: ethers.parseEther("60"),
  };
  await (await factory.connect(creator).createCampaign(req)).wait();
  const info = await factory.getCampaign(0);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);
  const locker = await ethers.getContractAt("PermanentLpLocker", await factory.permanentLpLocker());
  return { owner, creator, buyer, wbnb, topazFactory, router, treasury, nativeFeed, graduationOracle, factory, campaign, token, locker };
}

describe("LaunchCampaign native pending-first graduation", function () {
  this.timeout(120_000);

  it("keeps below-threshold trading in ordinary bonding", async () => {
    const { campaign, buyer, token } = await deployNativeCore();
    await (await campaign.connect(buyer).buyExactBnb(0, { value: ethers.parseEther("0.01") })).wait();
    expect(await campaign.graduationPending()).to.equal(false);
    expect(await campaign.launched()).to.equal(false);
    const sold = await campaign.sold();
    await (await token.connect(buyer).approve(await campaign.getAddress(), sold)).wait();
    await (await campaign.connect(buyer).sellExactTokens(sold, 0n)).wait();
  });

  it("marks pending on the threshold-crossing buy and does not Topaz-finalize in the same tx", async () => {
    const { campaign, buyer, token, topazFactory, wbnb } = await deployNativeCore();
    const tx = campaign.connect(buyer).buyExactBnb(0, { value: ethers.parseEther("0.11") });
    await expect(tx).to.emit(campaign, "StockGraduationPending");
    await expect(tx).to.not.emit(campaign, "CampaignFinalized");
    expect(await campaign.graduationPending()).to.equal(true);
    expect(await campaign.launched()).to.equal(false);
    const state = await campaign.getGraduationState();
    expect(await campaign.netRaisedWei()).to.equal(state.graduationBalance);
    expect(await topazFactory.getPool(await token.getAddress(), await wbnb.getAddress(), false)).to.equal(ethers.ZeroAddress);
  });

  it("freezes BUY and SELL once pending and completes from the frozen snapshot", async () => {
    const { campaign, buyer, token, locker, topazFactory, wbnb } = await deployNativeCore();
    await (await campaign.connect(buyer).buyExactBnb(0, { value: ethers.parseEther("0.11") })).wait();
    const frozen = await campaign.netRaisedWei();
    const frozenTarget = await campaign.pendingGraduationNativeTarget();

    await expect(campaign.connect(buyer).buyExactBnb(0, { value: ethers.parseEther("0.11") })).to.be.revertedWithCustomError(
      campaign,
      "GraduationPending",
    );
    await (await token.connect(buyer).approve(await campaign.getAddress(), 1n)).wait();
    await expect(campaign.connect(buyer).sellExactTokens(1n, 0n)).to.be.revertedWithCustomError(campaign, "GraduationPending");
    const quote = await campaign.quoteBuyExactBnb(ethers.parseEther("0.11"));
    expect(quote.tokensOut).to.equal(0n);

    const complete = campaign.connect(buyer).graduateIfEligible(0, 0);
    await expect(complete).to.emit(campaign, "CampaignFinalized");
    expect(await campaign.launched()).to.equal(true);
    expect(await campaign.graduationPending()).to.equal(false);
    const state = await campaign.getGraduationState();
    expect(state.graduationBalance).to.equal(frozen);
    expect(frozenTarget).to.be.gt(0n);
    expect(state.dexPair).to.not.equal(ethers.ZeroAddress);
    expect(state.dexPair).to.equal(await topazFactory.getPool(await token.getAddress(), await wbnb.getAddress(), false));
    expect(await locker.registeredLpToken(state.dexPair)).to.equal(true);
    expect(await token.tradingEnabled()).to.equal(true);
  });

  it("reverts the crossing BUY when the oracle is stale instead of remaining in open bonding", async () => {
    const { campaign, buyer, nativeFeed, graduationOracle } = await deployNativeCore();
    await setFeed(nativeFeed, 600n, 8, 1n);
    await expect(campaign.connect(buyer).buyExactBnb(0, { value: ethers.parseEther("0.11") })).to.be.revertedWithCustomError(
      graduationOracle,
      "StalePrice",
    );
    expect(await campaign.launched()).to.equal(false);
    expect(await campaign.graduationPending()).to.equal(false);
    expect(await campaign.netRaisedWei()).to.equal(0n);
  });

  it("reverts the crossing BUY when the oracle answer is invalid", async () => {
    const { campaign, buyer, nativeFeed, graduationOracle } = await deployNativeCore();
    const now = await nowTs();
    await (await nativeFeed.setRoundData(2, 0, now, now, 2)).wait();
    await expect(campaign.connect(buyer).buyExactBnb(0, { value: ethers.parseEther("0.11") })).to.be.revertedWithCustomError(
      graduationOracle,
      "InvalidPrice",
    );
    expect(await campaign.graduationPending()).to.equal(false);
    expect(await campaign.launched()).to.equal(false);
  });

  it("rejects duplicate completion after a successful native pending finalize", async () => {
    const { campaign, buyer } = await deployNativeCore();
    await (await campaign.connect(buyer).buyExactBnb(0, { value: ethers.parseEther("0.11") })).wait();
    await (await campaign.connect(buyer).graduateIfEligible(0, 0)).wait();
    await expect(campaign.connect(buyer).graduateIfEligible(0, 0)).to.be.revertedWithCustomError(campaign, "Finalized");
  });

  it("does not alter quote/stock pending retry or generation constants", async () => {
    const fs = await import("node:fs");
    const campaign = fs.readFileSync("contracts/LaunchCampaign.sol", "utf8");
    const quote = fs.readFileSync("contracts/BnbQuoteLaunchCampaign.sol", "utf8");
    const factory = fs.readFileSync("contracts/LaunchFactory.sol", "utf8");
    const keeper = fs.readFileSync("scripts/graduation-keeper.ts", "utf8");
    expect(campaign).to.match(/nativeTarget = graduationOracle\.nativeTargetForUsd/);
    expect(campaign).to.match(/_markStockGraduationPending\(caller, nativeTarget\)/);
    expect(campaign).not.to.match(/else _finalizeWithTarget\(0, 0, caller, nativeTarget\)/);
    expect(quote).to.match(/function _autoFinalizeIfEligible\(address caller\) internal override/);
    expect(quote).to.match(/\} catch \{\}/);
    expect(quote).to.match(/retryQuoteGraduation/);
    expect(factory).to.match(/FACTORY_GENERATION = 4/);
    expect(factory).to.match(/CAMPAIGN_GENERATION = 3/);
    expect(keeper).to.match(/retryPendingNativeGraduation/);
    expect(keeper).to.match(/retryPendingQuoteGraduation/);
  });
});
