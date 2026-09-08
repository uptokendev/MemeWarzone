import { expect } from "chai";
import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

const CREATOR_SHARE_BPS = 8000n;
const BPS = 10000n;
const V3_FEE = 3000;
const LIVE_BNB_FACTORY_GENERATION = 3n;
const LIVE_BNB_CAMPAIGN_GENERATION = 2n;

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function deployV3Adapter() {
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
  return adapter;
}

async function deploySourceHeadTopazStack() {
  const [owner, creator, buyer, weeklySigner, monthlySigner] = await ethers.getSigners();

  const WBNB = await ethers.getContractFactory("MockWBNB");
  const wbnb = await WBNB.deploy();
  await wbnb.waitForDeployment();

  const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
  const topazFactory = await TopazFactory.deploy();
  await topazFactory.waitForDeployment();

  const Router = await ethers.getContractFactory("MockTopazRouter");
  const router = await Router.deploy(await topazFactory.getAddress(), await wbnb.getAddress());
  await router.waitForDeployment();

  const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
  const priceFeed = await PriceFeed.deploy(8);
  await priceFeed.waitForDeployment();
  const now = await latestTimestamp();
  await priceFeed.setRoundData(1n, ethers.parseUnits("1", 8), now, now, 1n);

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const graduationOracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 30 * 24 * 60 * 60);
  await graduationOracle.waitForDeployment();

  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const monthly = await Receiver.deploy();
  const recruiter = await Receiver.deploy();
  await weekly.waitForDeployment();
  await monthly.waitForDeployment();
  await recruiter.waitForDeployment();

  const TreasuryRouter = await ethers.getContractFactory("TreasuryRouterV3");
  const treasuryRouter = await TreasuryRouter.deploy(
    await owner.getAddress(),
    await weekly.getAddress(),
    await monthly.getAddress(),
    3600,
  );
  await treasuryRouter.waitForDeployment();

  const Community = await ethers.getContractFactory("CommunityRewardsVaultV3Mock");
  const community = await Community.deploy();
  await community.waitForDeployment();

  const ProtocolVault = await ethers.getContractFactory("ProtocolRevenueVault");
  const protocolVault = await ProtocolVault.deploy(await owner.getAddress());
  await protocolVault.waitForDeployment();

  const CreatorVault = await ethers.getContractFactory("CreatorRewardsVault");
  const creatorVault = await CreatorVault.deploy(await owner.getAddress(), await treasuryRouter.getAddress());
  await creatorVault.waitForDeployment();

  await treasuryRouter.setRecruiterRewardsVault(await recruiter.getAddress());
  await treasuryRouter.setCommunityRewardsVault(await community.getAddress());
  await treasuryRouter.setProtocolRevenueVault(await protocolVault.getAddress());
  await treasuryRouter.setCreatorRewardsVault(await creatorVault.getAddress());

  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const campaignImplementation = await Campaign.deploy();
  await campaignImplementation.waitForDeployment();

  const Factory = await ethers.getContractFactory("LaunchFactory");
  const factory = await Factory.deploy(
    await router.getAddress(),
    await treasuryRouter.getAddress(),
    await campaignImplementation.getAddress(),
    await graduationOracle.getAddress(),
  );
  await factory.waitForDeployment();
  const locker = await ethers.getContractAt("PermanentLpLocker", await factory.permanentLpLocker());
  await treasuryRouter.setAuthorizedLpLocker(await locker.getAddress(), true);
  await router.setFeeCollector(await locker.getAddress());

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

  return {
    owner,
    creator,
    buyer,
    weeklySigner,
    monthlySigner,
    wbnb,
    topazFactory,
    router,
    treasuryRouter,
    protocolVault,
    creatorVault,
    community,
    recruiter,
    factory,
    locker,
  };
}

describe("BNB lifecycle certification (Gate D local source-head evidence)", function () {
  it("LaunchFactory 4/3 + Topaz V2 + TreasuryRouterV3 + kind 1 + 30 bps; not live BNB 3/2", async function () {
    this.timeout(180_000);
    const stack = await deploySourceHeadTopazStack();
    const {
      owner,
      creator,
      buyer,
      wbnb,
      topazFactory,
      router,
      treasuryRouter,
      protocolVault,
      creatorVault,
      factory,
      locker,
    } = stack;

    expect(await factory.FACTORY_GENERATION()).to.equal(4n);
    expect(await factory.CAMPAIGN_GENERATION()).to.equal(3n);
    expect(await factory.FACTORY_GENERATION()).to.not.equal(LIVE_BNB_FACTORY_GENERATION);
    expect(await factory.CAMPAIGN_GENERATION()).to.not.equal(LIVE_BNB_CAMPAIGN_GENERATION);
    expect(await factory.liquidityKind()).to.equal(1n);
    expect(await locker.REQUIRED_POOL_FEE_BPS()).to.equal(30n);
    expect(await locker.CREATOR_FEE_BPS()).to.equal(8000n);
    expect(await locker.PROTOCOL_FEE_BPS()).to.equal(2000n);
    expect(await locker.topazFactory()).to.equal(await topazFactory.getAddress());
    expect(await topazFactory.feeBps()).to.equal(30n);
    expect(await factory.feeRecipient()).to.equal(await treasuryRouter.getAddress());
    expect(await treasuryRouter.creatorRewardsVault()).to.equal(await creatorVault.getAddress());
    expect(locker.interface.fragments.filter((fragment: { name?: string }) => ["withdraw", "unlock", "migrate", "release"].includes(String(fragment.name || "")))).to.deep.equal([]);

    const v3Adapter = await deployV3Adapter();
    await expect(
      factory.connect(owner).setCoreRouting(await v3Adapter.getAddress(), await treasuryRouter.getAddress()),
    ).to.be.revertedWithCustomError(factory, "LiquidityKindMismatch");

    await factory.enableLive();

    const createTx = await factory.connect(creator).createCampaign({
      name: "CertToken",
      symbol: "CERT",
      logoURI: "ipfs://cert",
      xAccount: "",
      website: "",
      extraLink: "",
      graduationTarget: 0n,
    });
    const createReceipt = await createTx.wait();
    const created = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", created.campaign);
    const token = await ethers.getContractAt("LaunchToken", created.token);
    expect(await campaign.strictFeeRouting()).to.equal(true);
    expect(await campaign.lpReceiver()).to.equal(await locker.getAddress());

    const curveSupply = await campaign.curveSupply();
    const remaining = curveSupply - (await campaign.sold());
    const crossingCost = await campaign.quoteBuyExactTokens(remaining);
    const graduationTx = await campaign.connect(buyer).buyExactTokens(remaining, crossingCost, { value: crossingCost });
    await expect(graduationTx).to.emit(treasuryRouter, "RouteExecuted");
    const graduationReceipt = await graduationTx.wait();
    expect(await campaign.launched()).to.equal(true);
    expect(await creatorVault.pendingCreatorFees(created.campaign)).to.be.gt(0n);

    const state = await campaign.getGraduationState();
    expect(state.dexPair).to.not.equal(ethers.ZeroAddress);
    const pool = await ethers.getContractAt("MockTopazPool", state.dexPair);
    expect(await pool.stable()).to.equal(false);
    expect(await pool.factory()).to.equal(await topazFactory.getAddress());
    const tokenAddr = await token.getAddress();
    const wbnbAddr = await wbnb.getAddress();
    const token0 = await pool.token0();
    const token1 = await pool.token1();
    const pairMatches =
      (token0.toLowerCase() === tokenAddr.toLowerCase() && token1.toLowerCase() === wbnbAddr.toLowerCase()) ||
      (token0.toLowerCase() === wbnbAddr.toLowerCase() && token1.toLowerCase() === tokenAddr.toLowerCase());
    expect(pairMatches).to.equal(true);
    expect(await topazFactory.getFee(state.dexPair, false)).to.equal(30n);

    const lockerAddr = await locker.getAddress();
    const lpBeforeTrades = await pool.balanceOf(lockerAddr);
    expect(lpBeforeTrades).to.equal(state.graduatedLiquidityLp);
    expect(lpBeforeTrades).to.be.gt(0n);
    expect(await locker.lockedBalance(state.dexPair)).to.equal(lpBeforeTrades);

    await expect(
      locker.connect(owner).recoverUnregisteredToken(state.dexPair, await owner.getAddress(), 1n),
    ).to.be.revertedWithCustomError(locker, "OnlyAdmin");
    await ethers.provider.send("hardhat_impersonateAccount", [await factory.getAddress()]);
    await ethers.provider.send("hardhat_setBalance", [await factory.getAddress(), "0x56BC75E2D63100000"]);
    const factorySigner = await ethers.getSigner(await factory.getAddress());
    await expect(
      locker.connect(factorySigner).recoverUnregisteredToken(state.dexPair, await owner.getAddress(), 1n),
    ).to.be.revertedWithCustomError(locker, "RegisteredLpRecoveryBlocked");

    const factoryAddr = await topazFactory.getAddress();
    const buyRoute = [{ from: wbnbAddr, to: tokenAddr, stable: false, factory: factoryAddr }];
    const sellRoute = [{ from: tokenAddr, to: wbnbAddr, stable: false, factory: factoryAddr }];

    const buyTx = await router.connect(buyer).swapExactETHForTokens(
      1n,
      buyRoute,
      await buyer.getAddress(),
      (await latestTimestamp()) + 3600n,
      { value: ethers.parseEther("0.05") },
    );
    const buyReceipt = await buyTx.wait();

    const sellAmount = (await token.balanceOf(await buyer.getAddress())) / 10n;
    const quotedSell = await router.getAmountsOut(sellAmount, sellRoute);
    const wbnbNeeded = quotedSell[1];
    await wbnb.deposit({ value: wbnbNeeded });
    await wbnb.transfer(await router.getAddress(), wbnbNeeded);
    await token.connect(buyer).approve(await router.getAddress(), sellAmount);
    const sellTx = await router.connect(buyer).swapExactTokensForETH(
      sellAmount,
      1n,
      sellRoute,
      await buyer.getAddress(),
      (await latestTimestamp()) + 3600n,
    );
    const sellReceipt = await sellTx.wait();

    const claimable0 = await pool.claimable0(lockerAddr);
    const claimable1 = await pool.claimable1(lockerAddr);
    expect(claimable0 + claimable1).to.be.gt(0n);

    const tokenIs0 = token0.toLowerCase() === tokenAddr.toLowerCase();
    const claimedToken = tokenIs0 ? claimable0 : claimable1;
    const claimedWbnb = tokenIs0 ? claimable1 : claimable0;
    const expectedCreatorToken = (claimedToken * CREATOR_SHARE_BPS) / BPS;
    const expectedProtocolToken = claimedToken - expectedCreatorToken;
    const expectedCreatorWbnb = (claimedWbnb * CREATOR_SHARE_BPS) / BPS;
    const expectedProtocolWbnb = claimedWbnb - expectedCreatorWbnb;

    const creatorTokenBefore = await token.balanceOf(await creator.getAddress());
    const creatorWbnbBefore = await wbnb.balanceOf(await creator.getAddress());
    const protocolTokenBefore = await token.balanceOf(await protocolVault.getAddress());
    const protocolWbnbBefore = await wbnb.balanceOf(await protocolVault.getAddress());

    const harvestTx = await locker.harvest(state.dexPair);
    const harvestReceipt = await harvestTx.wait();

    const creatorTokenReceived = (await token.balanceOf(await creator.getAddress())) - creatorTokenBefore;
    const creatorWbnbReceived = (await wbnb.balanceOf(await creator.getAddress())) - creatorWbnbBefore;
    const protocolTokenReceived = (await token.balanceOf(await protocolVault.getAddress())) - protocolTokenBefore;
    const protocolWbnbReceived = (await wbnb.balanceOf(await protocolVault.getAddress())) - protocolWbnbBefore;
    const lpAfterHarvest = await pool.balanceOf(lockerAddr);

    expect(creatorTokenReceived).to.equal(expectedCreatorToken);
    expect(protocolTokenReceived).to.equal(expectedProtocolToken);
    expect(creatorWbnbReceived).to.equal(expectedCreatorWbnb);
    expect(protocolWbnbReceived).to.equal(expectedProtocolWbnb);
    expect(lpAfterHarvest).to.equal(lpBeforeTrades);
    expect(await locker.lockedBalance(state.dexPair)).to.equal(lpBeforeTrades);

    const evidence = {
      kind: "bnb-source-head-topaz-v2-lifecycle",
      claim: "local source-head future BNB generation; not current live BNB",
      sourceFactoryGeneration: 4,
      sourceCampaignGeneration: 3,
      liveBnbFactoryGeneration: 3,
      liveBnbCampaignGeneration: 2,
      sourceIsNotLiveBnb: true,
      liquidityKind: 1,
      requiredPoolFeeBps: 30,
      treasuryRouterKind: "TreasuryRouterV3",
      rejectedUniswapV3: true,
      campaign: created.campaign,
      token: created.token,
      creator: created.creator,
      graduatedPool: state.dexPair,
      graduationTx: graduationReceipt!.hash,
      buyTx: buyReceipt!.hash,
      sellTx: sellReceipt!.hash,
      harvestTx: harvestReceipt!.hash,
      lockerLpBalanceBeforeTrades: lpBeforeTrades.toString(),
      lockerLpBalanceAfterHarvest: lpAfterHarvest.toString(),
      claimedToken: claimedToken.toString(),
      claimedWbnb: claimedWbnb.toString(),
      creatorTokenReceived: creatorTokenReceived.toString(),
      creatorWbnbReceived: creatorWbnbReceived.toString(),
      protocolTokenReceived: protocolTokenReceived.toString(),
      protocolWbnbReceived: protocolWbnbReceived.toString(),
      pendingCreatorTradeFees: (await creatorVault.pendingCreatorFees(created.campaign)).toString(),
      finalCurvePrice: state.finalCurvePrice.toString(),
      initialDexPrice: state.initialDexPrice.toString(),
      createTx: createReceipt!.hash,
      launchFactory: await factory.getAddress(),
      topazRouter: await router.getAddress(),
      topazPoolFactory: factoryAddr,
      topazWbnb: wbnbAddr,
      treasuryRouterV3: await treasuryRouter.getAddress(),
      creatorRewardsVault: await creatorVault.getAddress(),
    };

    const outDir = path.join(__dirname, "..", "reports");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "bnb-lifecycle-certification-local.json");
    fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
    expect(state.finalCurvePrice).to.equal(state.initialDexPrice);
  });

  it("fails closed when Topaz reports 100 bps against the locker's required 30 bps", async function () {
    this.timeout(180_000);
    const { creator, buyer, topazFactory, factory, locker } = await deploySourceHeadTopazStack();
    expect(await locker.REQUIRED_POOL_FEE_BPS()).to.equal(30n);
    await topazFactory.setFeeBps(100);
    expect(await topazFactory.feeBps()).to.equal(100n);
    await factory.enableLive();

    await factory.connect(creator).createCampaign({
      name: "BadFee",
      symbol: "BADF",
      logoURI: "ipfs://bad-fee",
      xAccount: "",
      website: "",
      extraLink: "",
      graduationTarget: 0n,
    });
    const created = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", created.campaign);
    const remaining = (await campaign.curveSupply()) - (await campaign.sold());
    const crossingCost = await campaign.quoteBuyExactTokens(remaining);
    await expect(
      campaign.connect(buyer).buyExactTokens(remaining, crossingCost, { value: crossingCost }),
    ).to.be.revertedWithCustomError(locker, "InvalidTradingFee");
  });
});
