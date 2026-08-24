import { expect } from "chai";
import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

const CREATOR_SHARE_BPS = 8000n;
const BPS = 10000n;

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

describe("BNB lifecycle certification (Gate D local evidence)", function () {
  it("create → bond → graduate → Topaz BUY/SELL → harvest 80/20 → LP principal preserved", async function () {
    this.timeout(180_000);
    const [owner, creator, buyer] = await ethers.getSigners();

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

    const TreasuryVault = await ethers.getContractFactory("TreasuryVaultV2");
    const treasuryVault = await TreasuryVault.deploy(await owner.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress);
    await treasuryVault.waitForDeployment();

    const TreasuryRouter = await ethers.getContractFactory("TreasuryRouter");
    const treasuryRouter = await TreasuryRouter.deploy(await owner.getAddress(), await treasuryVault.getAddress(), 24 * 60 * 60);
    await treasuryRouter.waitForDeployment();

    const ProtocolVault = await ethers.getContractFactory("ProtocolRevenueVault");
    const protocolVault = await ProtocolVault.deploy(await owner.getAddress());
    await protocolVault.waitForDeployment();
    await treasuryRouter.setProtocolRevenueVault(await protocolVault.getAddress());

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
    await treasuryRouter.setPermanentLpLocker(await locker.getAddress());
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

    const curveSupply = await campaign.curveSupply();
    const remaining = curveSupply - (await campaign.sold());
    const crossingCost = await campaign.quoteBuyExactTokens(remaining);
    const graduationTx = await campaign.connect(buyer).buyExactTokens(remaining, crossingCost, { value: crossingCost });
    const graduationReceipt = await graduationTx.wait();
    expect(await campaign.launched()).to.equal(true);

    const state = await campaign.getGraduationState();
    expect(state.dexPair).to.not.equal(ethers.ZeroAddress);
    const pool = await ethers.getContractAt("MockTopazPool", state.dexPair);
    expect(await pool.stable()).to.equal(false);

    const lockerAddr = await locker.getAddress();
    const lpBeforeTrades = await pool.balanceOf(lockerAddr);
    expect(lpBeforeTrades).to.equal(state.graduatedLiquidityLp);
    expect(lpBeforeTrades).to.be.gt(0n);

    const wbnbAddr = await wbnb.getAddress();
    const tokenAddr = await token.getAddress();
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

    const tokenIs0 = (await pool.token0()).toLowerCase() === tokenAddr.toLowerCase();
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
      finalCurvePrice: state.finalCurvePrice.toString(),
      initialDexPrice: state.initialDexPrice.toString(),
      createTx: createReceipt!.hash,
      launchFactory: await factory.getAddress(),
      topazRouter: await router.getAddress(),
      topazPoolFactory: factoryAddr,
      topazWbnb: wbnbAddr,
    };

    const outDir = path.join(__dirname, "..", "reports");
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, "bnb-lifecycle-certification-local.json");
    fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
    expect(state.finalCurvePrice).to.equal(state.initialDexPrice);
  });
});
