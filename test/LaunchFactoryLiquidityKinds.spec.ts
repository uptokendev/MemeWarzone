import { expect } from "chai";
import { ethers } from "hardhat";
import { deployCoreFixture } from "./fixtures/core";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";
import { deployEvmGenRh } from "./fixtures/evmgenRh";
import { installRealV3, RH_V3 } from "./helpers/evmgenRhRealV3";
import { createCoin, req as evmReq, mineAt, buyNative } from "./fixtures/evmgenCore";

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

  // Was pending ("no V3 IGraduationAdapterV2 in source"); RobinhoodV3NativeGraduationAdapterV2 now exists
  // (claude/evm-rh). Real Uniswap V3 bytecode at the canonical 4663 addresses, real C5 campaign/factory.
  it("auto-registers a Robinhood V3 graduation NFT through the factory (RobinhoodV3NativeGraduationAdapterV2)", async () => {
    const env = await deployEvmGenRh();
    const { campaign, token } = await createCoin(env as any, evmReq({ graduationTarget: ethers.parseEther("30000") }));
    await mineAt(Number(await campaign.launchAt()) + 120);
    for (let i = 0; i < 20 && !(await campaign.graduationPending()); i++) {
      await buyNative(env as any, campaign, env.alice, ethers.parseEther("2"));
    }
    expect(await campaign.graduationPending()).to.equal(true);
    await campaign.connect(env.carol).graduate();

    const state = await campaign.getGraduationState();
    const pool = state.dexPair;
    expect(pool).to.equal(await env.v3Factory.getPool(await token.getAddress(), await env.weth.getAddress(), V3_FEE));
    const info = await env.locker.poolInfo(pool);
    expect(info.registered).to.equal(true);
    expect(info.campaign).to.equal(await campaign.getAddress());
    expect(info.creator).to.equal(env.creator.address);
    expect(await env.positionManager.ownerOf(info.tokenId)).to.equal(await env.locker.getAddress());
    const position = await env.positionManager.positions(info.tokenId);
    expect(info.lockedLiquidity).to.equal(position.liquidity);
    expect(position.fee).to.equal(3000n);
    expect(position.tickLower).to.equal(-887220n);
    expect(position.tickUpper).to.equal(887220n);
    expect(state.graduatedLiquidityLp).to.equal(position.liquidity);
    expect(await env.locker.pendingPositionByPool(pool)).to.equal(0n);
    // Start price is the curve price (C5 band 50 bps; here exact up to sqrt rounding).
    const p = state.finalCurvePrice;
    const start = state.initialDexPrice;
    expect((start > p ? start - p : p - start) * 10n ** 9n).to.be.lte(p);
    for (const holder of [await env.adapter.getAddress()]) {
      expect(await token.balanceOf(holder)).to.equal(0n);
      expect(await env.weth.balanceOf(holder)).to.equal(0n);
      expect(await ethers.provider.getBalance(holder)).to.equal(0n);
    }
  });

  it("setNativeGraduationAdapter accepts RobinhoodV3NativeGraduationAdapterV2 on a V3 factory whose router is another adapter", async () => {
    const [owner, , , weekly, monthly] = await ethers.getSigners();
    await installRealV3();
    const legacy = await (await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter")).deploy(RH_V3.v3Factory, RH_V3.positionManager, RH_V3.weth, V3_FEE);
    const treasury = await deployTreasury(owner, weekly, monthly);
    const oracle = await deployTestOracle();
    const implementation = await (await ethers.getContractFactory("LaunchCampaign")).deploy();
    const { factory } = await deployFactoryWithLocker({
      factoryName: "LaunchFactory",
      args: [await legacy.getAddress(), await treasury.getAddress(), await implementation.getAddress(), await oracle.getAddress()],
      lockerKind: "v3",
    });
    const locker = await ethers.getContractAt("PermanentV3PositionLocker", await factory.permanentLpLocker());
    const adapter = await (await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2")).deploy(RH_V3.v3Factory, RH_V3.positionManager, RH_V3.weth);
    // The locker reads liquidityKind/v3Factory/positionManager/WETH/feeTier off the adapter and they match.
    await expect(factory.setNativeGraduationAdapter(await adapter.getAddress()))
      .to.emit(factory, "NativeGraduationAdapterUpdated")
      .withArgs(await adapter.getAddress());
    expect(await locker.authorizedIntegrationSource(await adapter.getAddress())).to.equal(true);
    expect(await factory.nativeGraduationAdapter()).to.equal(await adapter.getAddress());
    // An adapter on a different V3 stack (another WETH) is refused by the locker.
    const otherWeth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const wrong = await (await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2")).deploy(RH_V3.v3Factory, RH_V3.positionManager, await otherWeth.getAddress());
    await expect(factory.setNativeGraduationAdapter(await wrong.getAddress())).to.be.reverted;
  });

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
