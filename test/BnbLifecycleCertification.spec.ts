import { expect } from "chai";
import { ethers } from "hardhat";
import fs from "fs";
import path from "path";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";

const CREATOR_SHARE_BPS = 8000n;
const BPS = 10000n;
const LIVE_BNB_FACTORY_GENERATION = 3n;
const LIVE_BNB_CAMPAIGN_GENERATION = 2n;
// The previous (6B) generation, 4/3, was replaced in place; its source is recoverable from c676ed7f.
const PREVIOUS_FACTORY_GENERATION = 4n;
const PREVIOUS_CAMPAIGN_GENERATION = 3n;

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

/**
 * Local source-head stack for the EVM launch generation on BNB: Topaz V2 mocks, TreasuryRouterV4 with the
 * generation's CreatorRewardsVaultV2, the factory-bound PermanentLpLocker. The native graduation adapter is
 * the generation's test double (MockGraduationAdapterEvmGen: builds a MEME/WBNB MockTopazPool and mints the LP
 * to the locker); no in-tree Topaz IGraduationAdapterV2 adapter exists yet, so the pool build itself is not
 * certified here -- the factory -> locker registration, the 30 bps gate, the permanent lock and the 80/20
 * harvest are.
 */
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

  const TreasuryRouter = await ethers.getContractFactory("TreasuryRouterV4");
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

  const CreatorVault = await ethers.getContractFactory("CreatorRewardsVaultV2");
  const creatorVault = await CreatorVault.deploy(
    await owner.getAddress(),
    await treasuryRouter.getAddress(),
    await wbnb.getAddress(),
    1, // DEX_TOPAZ_V2
    await topazFactory.getAddress(),
    24 * 60 * 60,
  );
  await creatorVault.waitForDeployment();

  await treasuryRouter.setRecruiterRewardsVault(await recruiter.getAddress());
  await treasuryRouter.setCommunityRewardsVault(await community.getAddress());
  await treasuryRouter.setProtocolRevenueVault(await protocolVault.getAddress());
  await treasuryRouter.setCreatorRewardsVault(await creatorVault.getAddress());

  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const campaignImplementation = await Campaign.deploy();
  await campaignImplementation.waitForDeployment();

  const factory = await (await deployFactoryWithLocker({ factoryName: "LaunchFactory", args: [await router.getAddress(),
    await treasuryRouter.getAddress(),
    await campaignImplementation.getAddress(),
    await graduationOracle.getAddress()] })).factory;
  await factory.waitForDeployment();
  const locker = await ethers.getContractAt("PermanentLpLocker", await factory.permanentLpLocker());
  await treasuryRouter.setAuthorizedLpLocker(await locker.getAddress(), true);
  await creatorVault.setFactoryOnce(await factory.getAddress());

  const graduationAdapter = await (await ethers.getContractFactory("MockGraduationAdapterEvmGen")).deploy(
    await topazFactory.getAddress(),
    await wbnb.getAddress(),
  );
  await graduationAdapter.waitForDeployment();
  await graduationAdapter.setLocker(await locker.getAddress());
  await factory.setNativeGraduationAdapter(await graduationAdapter.getAddress());
  const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
  await tokenDeployer.waitForDeployment();
  await factory.setLaunchTokenDeployer(await tokenDeployer.getAddress());

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
    graduationAdapter,
  };
}

const CERT_REQUEST = {
  name: "CertToken",
  symbol: "CERT",
  logoURI: "ipfs://cert",
  xAccount: "",
  website: "",
  extraLink: "",
  graduationTarget: 0n,
  firstBuyTokens: 0n,
  firstBuyMaxCost: 0n,
  feeChoice: 1,
  feeCreatorPct: 0,
};

/** Buys the whole remaining curve (sold-out trigger): the crossing buy only marks Pending (C5). */
async function sellOut(campaign: any, buyer: any) {
  const remaining = (await campaign.curveSupply()) - (await campaign.sold());
  const crossingCost = await campaign.quoteBuyExactTokens(remaining);
  const tx = await campaign.connect(buyer).buyExactTokens(remaining, crossingCost, { value: crossingCost });
  await expect(tx).to.emit(campaign, "GraduationPending");
  expect(await campaign.graduationPending()).to.equal(true);
  expect(await campaign.launched()).to.equal(false);
  return tx;
}

describe("BNB lifecycle certification (Gate D local source-head evidence)", function () {
  it("LaunchFactory 6/5 + Topaz V2 + TreasuryRouterV4 + kind 1 + 30 bps; not live BNB 3/2 nor the replaced 4/3", async function () {
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
      graduationAdapter,
    } = stack;

    expect(await factory.FACTORY_GENERATION()).to.equal(6n);
    expect(await factory.CAMPAIGN_GENERATION()).to.equal(5n);
    expect(await factory.FACTORY_GENERATION()).to.not.equal(LIVE_BNB_FACTORY_GENERATION);
    expect(await factory.CAMPAIGN_GENERATION()).to.not.equal(LIVE_BNB_CAMPAIGN_GENERATION);
    expect(await factory.FACTORY_GENERATION()).to.not.equal(PREVIOUS_FACTORY_GENERATION);
    expect(await factory.CAMPAIGN_GENERATION()).to.not.equal(PREVIOUS_CAMPAIGN_GENERATION);
    expect(await factory.liquidityKind()).to.equal(1n);
    expect(await locker.REQUIRED_LIQUIDITY_KIND()).to.equal(1n);
    expect(await locker.CREATOR_FEE_BPS()).to.equal(8000n);
    expect(await locker.PROTOCOL_FEE_BPS()).to.equal(2000n);
    expect(await locker.admin()).to.equal(await factory.getAddress());
    expect(await locker.topazFactory()).to.equal(await topazFactory.getAddress());
    expect(await topazFactory.feeBps()).to.equal(30n);
    expect(await factory.feeRecipient()).to.equal(await treasuryRouter.getAddress());
    expect(await factory.leagueReceiver()).to.equal(await treasuryRouter.getAddress());
    expect(await treasuryRouter.creatorRewardsVault()).to.equal(await creatorVault.getAddress());
    expect(locker.interface.fragments.filter((fragment: { name?: string }) => ["withdraw", "unlock", "migrate", "release"].includes(String(fragment.name || "")))).to.deep.equal([]);

    // The DEX router, fee recipient and league receiver are fixed at construction: a V3 router can never be
    // swapped in behind a Topaz V2 locker (setCoreRouting and its LiquidityKindMismatch path are gone).
    expect(factory.interface.getFunction("setCoreRouting")).to.equal(null);

    await factory.enableLive();

    const createTx = await factory.connect(creator).createCampaign(CERT_REQUEST);
    const createReceipt = await createTx.wait();
    const created = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", created.campaign);
    const token = await ethers.getContractAt("LaunchToken", created.token);
    expect(await campaign.graduationAdapter()).to.equal(await graduationAdapter.getAddress());
    expect(await campaign.feeRecipient()).to.equal(await treasuryRouter.getAddress());

    const pendingTx = await sellOut(campaign, buyer);
    await expect(pendingTx).to.emit(treasuryRouter, "RouteExecuted");
    expect(await creatorVault.creatorBalance(created.campaign)).to.be.gt(0n);

    // Anyone completes it.
    const graduationTx = await campaign.connect(buyer).graduate();
    await expect(graduationTx).to.emit(campaign, "Graduated");
    await expect(graduationTx).to.emit(factory, "CampaignGraduated");
    const graduationReceipt = await graduationTx.wait();
    expect(await campaign.launched()).to.equal(true);
    expect(await campaign.graduationPending()).to.equal(false);

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
    const info = await locker.poolInfo(state.dexPair);
    expect(info.registered).to.equal(true);
    expect(info.campaign).to.equal(created.campaign);
    expect(info.creatorFeeRecipient).to.equal(await creator.getAddress()); // Keep coin
    expect(info.memeToken).to.equal(tokenAddr);
    expect(info.pairedToken).to.equal(wbnbAddr);

    await expect(
      locker.connect(owner).recoverUnregisteredToken(state.dexPair, await owner.getAddress(), 1n),
    ).to.be.revertedWithCustomError(locker, "OnlyAdmin");
    await ethers.provider.send("hardhat_impersonateAccount", [await factory.getAddress()]);
    await ethers.provider.send("hardhat_setBalance", [await factory.getAddress(), "0x56BC75E2D63100000"]);
    const factorySigner = await ethers.getSigner(await factory.getAddress());
    await expect(
      locker.connect(factorySigner).recoverUnregisteredToken(state.dexPair, await owner.getAddress(), 1n),
    ).to.be.revertedWithCustomError(locker, "RegisteredLpRecoveryBlocked");
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [await factory.getAddress()]);

    // LP fees accrue to the locker in both assets (the mock pool is funded directly: the test double builds
    // the pool without reserves, so there is nothing to swap against).
    const feeWbnb = ethers.parseEther("0.003");
    const feeMeme = ethers.parseEther("1");
    await wbnb.connect(buyer).deposit({ value: feeWbnb });
    await wbnb.connect(buyer).approve(state.dexPair, feeWbnb);
    await token.connect(buyer).approve(state.dexPair, feeMeme);
    const tokenIs0 = token0.toLowerCase() === tokenAddr.toLowerCase();
    await pool.connect(buyer).fundFees(lockerAddr, tokenIs0 ? feeMeme : feeWbnb, tokenIs0 ? feeWbnb : feeMeme);

    const claimable0 = await pool.claimable0(lockerAddr);
    const claimable1 = await pool.claimable1(lockerAddr);
    const claimedToken = tokenIs0 ? claimable0 : claimable1;
    const claimedWbnb = tokenIs0 ? claimable1 : claimable0;
    expect(claimedToken).to.equal(feeMeme);
    expect(claimedWbnb).to.equal(feeWbnb);
    // E9: the MEME side is never paid out; the local Topaz mock cannot swap, so it is carried.
    const expectedCreatorToken = 0n;
    const expectedProtocolToken = 0n;
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
    expect(await locker.carriedMeme(state.dexPair)).to.equal(feeMeme);
    expect(lpAfterHarvest).to.equal(lpBeforeTrades);
    expect(await locker.lockedBalance(state.dexPair)).to.equal(lpBeforeTrades);

    const evidence = {
      kind: "bnb-source-head-topaz-v2-lifecycle",
      claim: "local source-head EVM launch generation on BNB; not current live BNB",
      sourceFactoryGeneration: 6,
      sourceCampaignGeneration: 5,
      liveBnbFactoryGeneration: 3,
      liveBnbCampaignGeneration: 2,
      sourceIsNotLiveBnb: true,
      liquidityKind: 1,
      requiredPoolFeeBps: 30,
      treasuryRouterKind: "TreasuryRouterV4",
      coreRoutingImmutable: true,
      graduationAdapter: "MockGraduationAdapterEvmGen (test double; no in-tree Topaz IGraduationAdapterV2 adapter yet)",
      campaign: created.campaign,
      token: created.token,
      creator: created.creator,
      graduatedPool: state.dexPair,
      pendingTx: (await pendingTx.wait())!.hash,
      graduationTx: graduationReceipt!.hash,
      harvestTx: harvestReceipt!.hash,
      lockerLpBalanceBeforeTrades: lpBeforeTrades.toString(),
      lockerLpBalanceAfterHarvest: lpAfterHarvest.toString(),
      claimedToken: claimedToken.toString(),
      claimedWbnb: claimedWbnb.toString(),
      creatorTokenReceived: creatorTokenReceived.toString(),
      creatorWbnbReceived: creatorWbnbReceived.toString(),
      protocolTokenReceived: protocolTokenReceived.toString(),
      protocolWbnbReceived: protocolWbnbReceived.toString(),
      pendingCreatorTradeFees: (await creatorVault.creatorBalance(created.campaign)).toString(),
      finalCurvePrice: state.finalCurvePrice.toString(),
      initialDexPrice: state.initialDexPrice.toString(),
      createTx: createReceipt!.hash,
      launchFactory: await factory.getAddress(),
      topazRouter: await router.getAddress(),
      topazPoolFactory: await topazFactory.getAddress(),
      topazWbnb: wbnbAddr,
      treasuryRouterV4: await treasuryRouter.getAddress(),
      creatorRewardsVault: await creatorVault.getAddress(),
    };

    const outDir = path.join(__dirname, "..", "reports");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "bnb-lifecycle-certification-local.json");
    fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
    expect(state.finalCurvePrice).to.equal(state.initialDexPrice);
  });

  it("E13: graduates when Topaz reports 100 bps and the locker records the pool's real fee", async function () {
    this.timeout(180_000);
    const { creator, buyer, topazFactory, factory, locker } = await deploySourceHeadTopazStack();
    expect(await locker.REQUIRED_LIQUIDITY_KIND()).to.equal(1n);
    await topazFactory.setFeeBps(100);
    expect(await topazFactory.feeBps()).to.equal(100n);
    await factory.enableLive();

    await factory.connect(creator).createCampaign({ ...CERT_REQUEST, name: "CustomFee", symbol: "CFEE", logoURI: "ipfs://custom-fee" });
    const created = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", created.campaign);

    // Topaz's fee manager setting a pool fee other than 30 bps no longer freezes a graduation (E13).
    await sellOut(campaign, buyer);
    await campaign.connect(buyer).graduate();
    expect(await campaign.launched()).to.equal(true);
    expect(await factory.campaignGraduationRecorded(created.campaign)).to.equal(true);
    const pair = (await campaign.getGraduationState()).dexPair;
    expect(pair).to.not.equal(ethers.ZeroAddress);
    const info = await locker.poolInfo(pair);
    expect(info.registered).to.equal(true);
    expect(info.poolFeeBps).to.equal(100n);
  });
});
