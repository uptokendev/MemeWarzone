import { expect } from "chai";
import { ethers } from "hardhat";
import { deployCoreFixture } from "./fixtures/core";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";

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
  // Launch generation: create registers the fee choice on the router's creator vault (setCampaignChoice).
  const CreatorVault = await ethers.getContractFactory("MockCreatorRewardsVaultEvmGen");
  const creatorVault = await CreatorVault.deploy();
  await creatorVault.waitForDeployment();

  await treasury.setRecruiterRewardsVault(await recruiter.getAddress());
  await treasury.setCommunityRewardsVault(await community.getAddress());
  await treasury.setProtocolRevenueVault(await protocol.getAddress());
  await treasury.setCreatorRewardsVault(await creatorVault.getAddress());
  return Object.assign(treasury, { creatorVault });
}

describe("LaunchFactory V2/V3 liquidity-kind seam", function () {
  it("preserves the existing BNB/Topaz V2 locker path and refuses a V3 router switch", async () => {
    const { factory, permanentLpLocker, v2factory, router, owner } = await deployCoreFixture();

    expect(await factory.FACTORY_GENERATION()).to.equal(6n);
    expect(await factory.CAMPAIGN_GENERATION()).to.equal(5n);
    expect(await factory.liquidityKind()).to.equal(1n);
    expect(await factory.permanentLpLocker()).to.equal(await permanentLpLocker.getAddress());
    expect(await permanentLpLocker.topazFactory()).to.equal(await v2factory.getAddress());
    expect(await permanentLpLocker.admin()).to.equal(await factory.getAddress());

    // Launch generation: the DEX router is fixed at construction and there is no setter to switch it
    // (setCoreRouting removed); the V3-only stock hooks refuse a V2 factory.
    expect(factory.interface.getFunction("setCoreRouting")).to.equal(null);
    expect(await factory.router()).to.equal(await router.getAddress());
    await expect(factory.connect(owner).setStockGraduationAdapter(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      factory,
      "UnsupportedLiquidityKind",
    );
    await expect(factory.connect(owner).setStockCampaignImplementation(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      factory,
      "UnsupportedLiquidityKind",
    );
  });

  it("binds a Robinhood V3 factory to its V3 position locker with the V3 adapter as integration source", async () => {
    const [owner, creator, , weekly, monthly] = await ethers.getSigners();
    const { weth, v3Factory, positionManager, adapter } = await deployV3Stack();
    const treasury = await deployTreasury(owner, weekly, monthly);
    const oracle = await deployTestOracle();

    const Campaign = await ethers.getContractFactory("LaunchCampaign");
    const implementation = await Campaign.deploy();
    await implementation.waitForDeployment();

    const factory = await (await deployFactoryWithLocker({ factoryName: "LaunchFactory", args: [await adapter.getAddress(),
      await treasury.getAddress(),
      await implementation.getAddress(),
      await oracle.getAddress()] })).factory;
    await factory.waitForDeployment();

    expect(await factory.FACTORY_GENERATION()).to.equal(6n);
    expect(await factory.CAMPAIGN_GENERATION()).to.equal(5n);
    expect(await factory.liquidityKind()).to.equal(2n);
    // C5 §2: the Robinhood (V3) default slope is 850.
    expect((await factory.config()).priceSlope).to.equal(850n);

    const lockerAddress = await factory.permanentLpLocker();
    const locker = await ethers.getContractAt("PermanentV3PositionLocker", lockerAddress);
    expect(await locker.admin()).to.equal(await factory.getAddress());
    expect(await locker.integrationSource()).to.equal(await adapter.getAddress());
    expect(await locker.positionManager()).to.equal(await positionManager.getAddress());
    expect(await locker.v3Factory()).to.equal(await v3Factory.getAddress());
    expect(await locker.wrappedNative()).to.equal(await weth.getAddress());

    // The factory refuses to create until a native graduation adapter is set, and the V3 router itself is
    // accepted as that adapter (no extra integration source is authorized on the locker for it).
    await factory.setRequireRouteAuthorization(false);
    await factory.setRequireAuthorizedTrading(false);
    await factory.setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000,
      liquidityTokenBps: 4000,
      basePrice: 10n ** 12n,
      priceSlope: 10n ** 9n,
      graduationTarget: 1n,
    });
    await factory.enableLive();
    const req = {
      name: "Robinhood Factory Token",
      symbol: "RHFAC",
      logoURI: "ipfs://robinhood-factory",
      xAccount: "",
      website: "",
      extraLink: "",
      graduationTarget: 1n,
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: 1,
      feeCreatorPct: 0,
    };
    await expect(factory.connect(creator).createCampaign(req)).to.be.revertedWithCustomError(factory, "NativeGraduationAdapterUnavailable");

    await (treasury as any).creatorVault.setFactory(await factory.getAddress());
    await expect(factory.setNativeGraduationAdapter(await adapter.getAddress()))
      .to.emit(factory, "NativeGraduationAdapterUpdated")
      .withArgs(await adapter.getAddress());
    await factory.setLaunchTokenDeployer(await (await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy()).getAddress());
    await expect(factory.connect(creator).createCampaign(req)).to.emit(factory, "CampaignCreated");
    const campaign = await ethers.getContractAt("LaunchCampaign", (await factory.getCampaign(0n)).campaign);
    expect(await campaign.graduationAdapter()).to.equal(await adapter.getAddress());
  });

  // CONTRACT FINDING: the source has no IGraduationAdapterV2 for Robinhood V3 native coins.
  // RobinhoodUniswapV3GraduationAdapter (contracts/integrations/RobinhoodUniswapV3GraduationAdapter.sol) still only
  // has the old addLiquidityETH path and no graduate(Request); LaunchCampaign.graduate() calls
  // IGraduationAdapterV2(graduationAdapter).graduate (LaunchCampaign.sol:750), so a native coin on a V3 factory can
  // never graduate and the factory's V3 NFT auto-registration (LaunchFactory.notifyCampaignGraduated) cannot be
  // exercised end to end. Re-enable once the V3 native adapter exists: create -> sell out -> graduate() -> pool
  // NFT owned by the locker, locker.poolInfo(pool) registered with campaign/creator/tokenId/lockedLiquidity.
  it.skip("CONTRACT FINDING: auto-registers a Robinhood V3 graduation NFT through the factory (no V3 IGraduationAdapterV2 in source)", async () => {});

  it("refuses to switch a V3 factory back to a legacy V2 router even before first campaign", async () => {
    const [owner, , , weekly, monthly] = await ethers.getSigners();
    const { adapter } = await deployV3Stack();
    const treasury = await deployTreasury(owner, weekly, monthly);
    const oracle = await deployTestOracle();

    const Campaign = await ethers.getContractFactory("LaunchCampaign");
    const implementation = await Campaign.deploy();
    await implementation.waitForDeployment();

    const factory = await (await deployFactoryWithLocker({ factoryName: "LaunchFactory", args: [await adapter.getAddress(),
      await treasury.getAddress(),
      await implementation.getAddress(),
      await oracle.getAddress()] })).factory;
    await factory.waitForDeployment();

    // Launch generation: router, liquidity kind and locker are construction-time and immutable; there is no
    // setter left that could point a V3 factory at a V2 router (setCoreRouting removed). A V2 locker cannot be
    // bound to a V3 router either (evmgen-hardening-locker-binding > "refuses ... one of the wrong kind").
    expect(factory.interface.getFunction("setCoreRouting")).to.equal(null);
    const setters = factory.interface.fragments
      .filter((f: any) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
      .map((f: any) => f.name as string);
    expect(setters.filter((n: string) => /router|routing|locker/i.test(n))).to.deep.equal([]);
    expect(await factory.router()).to.equal(await adapter.getAddress());
    expect(await factory.liquidityKind()).to.equal(2n);
  });
});
