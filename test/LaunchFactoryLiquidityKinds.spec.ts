import { expect } from "chai";
import { ethers } from "hardhat";
import { deployCoreFixture } from "./fixtures/core";

const V3_FEE = 3000;

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function deployTestOracle(price = "1") {
  const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
  const priceFeed = await PriceFeed.deploy(8);
  await priceFeed.waitForDeployment();
  const now = await latestTimestamp();
  await priceFeed.setRoundData(1n, ethers.parseUnits(price, 8), now, now, 1n);

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const oracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 30 * 24 * 60 * 60);
  await oracle.waitForDeployment();
  return oracle;
}

async function deployV3Stack() {
  const WETH = await ethers.getContractFactory("MockWETH9");
  const weth = await WETH.deploy();
  await weth.waitForDeployment();

  const V3Factory = await ethers.getContractFactory("MockUniswapV3Factory");
  const v3Factory = await V3Factory.deploy();
  await v3Factory.waitForDeployment();

  const PositionManager = await ethers.getContractFactory("MockUniswapV3PositionManager");
  const positionManager = await PositionManager.deploy(await v3Factory.getAddress(), await weth.getAddress());
  await positionManager.waitForDeployment();

  const SwapRouter = await ethers.getContractFactory("MockUniswapV3SwapRouter");
  const swapRouter = await SwapRouter.deploy(await v3Factory.getAddress(), await weth.getAddress());
  await swapRouter.waitForDeployment();
  await v3Factory.configurePeriphery(await positionManager.getAddress(), await swapRouter.getAddress());

  const Adapter = await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter");
  const adapter = await Adapter.deploy(
    await v3Factory.getAddress(),
    await positionManager.getAddress(),
    await weth.getAddress(),
    V3_FEE,
  );
  await adapter.waitForDeployment();

  return { weth, v3Factory, positionManager, swapRouter, adapter };
}

async function deployTreasury(owner: any, weekly: any, monthly: any) {
  const Treasury = await ethers.getContractFactory("TreasuryRouterV3");
  const treasury = await Treasury.deploy(
    await owner.getAddress(),
    await weekly.getAddress(),
    await monthly.getAddress(),
    3600,
  );
  await treasury.waitForDeployment();

  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const recruiter = await Receiver.deploy();
  const protocol = await Receiver.deploy();
  await recruiter.waitForDeployment();
  await protocol.waitForDeployment();
  const Community = await ethers.getContractFactory("CommunityRewardsVaultV3Mock");
  const community = await Community.deploy();
  await community.waitForDeployment();
  const CreatorVault = await ethers.getContractFactory("CreatorRewardsVault");
  const creatorVault = await CreatorVault.deploy(await owner.getAddress(), await treasury.getAddress());
  await creatorVault.waitForDeployment();

  await treasury.setRecruiterRewardsVault(await recruiter.getAddress());
  await treasury.setCommunityRewardsVault(await community.getAddress());
  await treasury.setProtocolRevenueVault(await protocol.getAddress());
  await treasury.setCreatorRewardsVault(await creatorVault.getAddress());
  return treasury;
}

describe("LaunchFactory V2/V3 liquidity-kind seam", function () {
  it("preserves the existing BNB/Topaz V2 locker path and refuses a V3 router switch", async () => {
    const { factory, permanentLpLocker, v2factory, treasuryRouter, owner } = await deployCoreFixture();
    const { adapter } = await deployV3Stack();

    expect(await factory.FACTORY_GENERATION()).to.equal(4n);
    expect(await factory.CAMPAIGN_GENERATION()).to.equal(3n);
    expect(await factory.liquidityKind()).to.equal(1n);
    expect(await factory.permanentLpLocker()).to.equal(await permanentLpLocker.getAddress());
    expect(await permanentLpLocker.topazFactory()).to.equal(await v2factory.getAddress());

    await expect(
      factory.connect(owner).setCoreRouting(await adapter.getAddress(), await treasuryRouter.getAddress()),
    ).to.be.revertedWithCustomError(factory, "LiquidityKindMismatch");
  });

  it("auto-registers a Robinhood V3 graduation NFT through the factory without touching LaunchCampaign", async () => {
    const [owner, creator, buyer, weekly, monthly] = await ethers.getSigners();
    const { weth, v3Factory, positionManager, adapter } = await deployV3Stack();
    const treasury = await deployTreasury(owner, weekly, monthly);
    const oracle = await deployTestOracle();

    const Campaign = await ethers.getContractFactory("LaunchCampaign");
    const implementation = await Campaign.deploy();
    await implementation.waitForDeployment();

    const Factory = await ethers.getContractFactory("LaunchFactory");
    const factory = await Factory.deploy(
      await adapter.getAddress(),
      await treasury.getAddress(),
      await implementation.getAddress(),
      await oracle.getAddress(),
    );
    await factory.waitForDeployment();

    expect(await factory.FACTORY_GENERATION()).to.equal(4n);
    expect(await factory.CAMPAIGN_GENERATION()).to.equal(3n);
    expect(await factory.liquidityKind()).to.equal(2n);

    const lockerAddress = await factory.permanentLpLocker();
    const locker = await ethers.getContractAt("PermanentV3PositionLocker", lockerAddress);
    expect(await locker.integrationSource()).to.equal(await adapter.getAddress());
    expect(await locker.positionManager()).to.equal(await positionManager.getAddress());
    expect(await locker.v3Factory()).to.equal(await v3Factory.getAddress());
    expect(await locker.wrappedNative()).to.equal(await weth.getAddress());

    await treasury.setAuthorizedLpLocker(lockerAddress, true);
    await factory.setRequireRouteAuthorization(false);
    await factory.setRequireAuthorizedTrading(false);
    await factory.setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000,
      liquidityTokenBps: 4000,
      basePrice: 10n ** 12n,
      priceSlope: 10n ** 9n,
      graduationTarget: 1n,
      liquidityBps: 8000,
    });
    await factory.enableLive();

    await factory.connect(creator).createCampaign({
      name: "Robinhood Factory Token",
      symbol: "RHFAC",
      logoURI: "ipfs://robinhood-factory",
      xAccount: "",
      website: "",
      extraLink: "",
      graduationTarget: 1n,
    });

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const token = await ethers.getContractAt("LaunchToken", info.token);
    expect(await campaign.lpReceiver()).to.equal(lockerAddress);

    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);
    const buyTx = campaign.connect(buyer).buyExactTokens(curveSupply, totalBuy, { value: totalBuy });
    await expect(buyTx).to.emit(campaign, "CampaignFinalized");

    const state = await campaign.getGraduationState();
    const poolAddress = await v3Factory.getPool(await token.getAddress(), await weth.getAddress(), V3_FEE);
    expect(poolAddress).to.not.equal(ethers.ZeroAddress);
    expect(state.dexPair).to.equal(poolAddress);
    expect(state.graduatedLiquidityLp).to.be.greaterThan(0n);

    expect(await factory.campaignGraduationRecorded(info.campaign)).to.equal(true);
    expect(await locker.registeredLpToken(poolAddress)).to.equal(true);
    expect(await locker.pendingPositionByPool(poolAddress)).to.equal(0n);
    expect(await locker.lockedBalance(poolAddress)).to.equal(state.graduatedLiquidityLp);
    expect(await positionManager.ownerOf(1n)).to.equal(lockerAddress);

    const registration = await locker.poolInfo(poolAddress);
    expect(registration.registered).to.equal(true);
    expect(registration.campaign).to.equal(info.campaign);
    expect(registration.creator).to.equal(await creator.getAddress());
    expect(registration.tokenId).to.equal(1n);
    expect(registration.lockedLiquidity).to.equal(state.graduatedLiquidityLp);
  });

  it("refuses to switch a V3 factory back to a legacy V2 router even before first campaign", async () => {
    const [owner, , , weekly, monthly] = await ethers.getSigners();
    const { adapter } = await deployV3Stack();
    const treasury = await deployTreasury(owner, weekly, monthly);
    const oracle = await deployTestOracle();

    const Campaign = await ethers.getContractFactory("LaunchCampaign");
    const implementation = await Campaign.deploy();
    await implementation.waitForDeployment();

    const Factory = await ethers.getContractFactory("LaunchFactory");
    const factory = await Factory.deploy(
      await adapter.getAddress(),
      await treasury.getAddress(),
      await implementation.getAddress(),
      await oracle.getAddress(),
    );
    await factory.waitForDeployment();

    const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
    const topazFactory = await TopazFactory.deploy();
    await topazFactory.waitForDeployment();
    const TopazRouter = await ethers.getContractFactory("MockTopazRouter");
    const topazRouter = await TopazRouter.deploy(await topazFactory.getAddress(), await owner.getAddress());
    await topazRouter.waitForDeployment();

    await expect(
      factory.setCoreRouting(await topazRouter.getAddress(), await treasury.getAddress()),
    ).to.be.revertedWithCustomError(factory, "LiquidityKindMismatch");
  });
});
