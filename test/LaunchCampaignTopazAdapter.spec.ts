import { expect } from "chai";
import { ethers } from "hardhat";

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
  const graduationOracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 30 * 24 * 60 * 60);
  await graduationOracle.waitForDeployment();
  return graduationOracle;
}

async function deployDirectCampaign(params: any) {
  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const impl = await Campaign.deploy();
  await impl.waitForDeployment();

  const implAddr = await impl.getAddress();
  const minimalProxyBytecode =
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" +
    implAddr.slice(2).toLowerCase() +
    "5af43d82803e903d91602b57fd5bf3";

  const [deployer] = await ethers.getSigners();
  const txClone = await deployer.sendTransaction({ data: minimalProxyBytecode });
  const receipt = await txClone.wait();
  const cloneAddr = receipt!.contractAddress;
  const campaign = Campaign.attach(cloneAddr);
  await campaign.initialize(params);
  return campaign;
}

describe("LaunchCampaign TopazRouterAdapter integration", function () {
  it("graduates through the production-router adapter without trapping tokens, BNB, or approvals", async () => {
    const [owner, creator, buyer, lpReceiver] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("MockTopazFactory");
    const topazFactory = await Factory.deploy();
    await topazFactory.waitForDeployment();

    const WBNB = await ethers.getContractFactory("MockWBNB");
    const wbnb = await WBNB.deploy();
    await wbnb.waitForDeployment();

    const ProductionRouter = await ethers.getContractFactory("MockTopazProductionRouter");
    const productionRouter = await ProductionRouter.deploy(await topazFactory.getAddress(), await wbnb.getAddress());
    await productionRouter.waitForDeployment();

    const Adapter = await ethers.getContractFactory("TopazRouterAdapter");
    const adapter = await Adapter.deploy(await productionRouter.getAddress());
    await adapter.waitForDeployment();

    const graduationOracle = await deployTestOracle();
    const campaign = await deployDirectCampaign({
      name: "Adapter Token",
      symbol: "ADAPT",
      logoURI: "ipfs://logo",
      xAccount: "",
      website: "",
      extraLink: "",
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000,
      liquidityTokenBps: 4000,
      basePrice: 10n ** 12n,
      priceSlope: 10n ** 9n,
      graduationTarget: 1n,
      graduationOracle: await graduationOracle.getAddress(),
      liquidityBps: 8000,
      protocolFeeBps: 0,
      leagueFeeBps: 0,
      leagueReceiver: await owner.getAddress(),
      router: await adapter.getAddress(),
      lpReceiver: await lpReceiver.getAddress(),
      feeRecipient: await owner.getAddress(),
      creator: await creator.getAddress(),
      factory: ethers.ZeroAddress,
      creatorRegistry: ethers.ZeroAddress,
      riskRegistry: ethers.ZeroAddress,
      creatorBuyLockUntil: 0n,
      creatorBuyCapWei: 0n,
      requireAuthorizedTrading: false,
      tradeRouteProfile: 1,
      finalizeRouteProfile: 1,
      strictFeeRouting: false,
    });

    const token = await ethers.getContractAt("LaunchToken", await campaign.token());
    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);

    await expect(campaign.connect(buyer).buyExactTokens(curveSupply, totalBuy, { value: totalBuy })).to.emit(campaign, "CampaignFinalized");

    const poolAddress = await topazFactory.getPool(await token.getAddress(), await wbnb.getAddress(), false);
    const pool = await ethers.getContractAt("MockTopazPool", poolAddress);
    const state = await campaign.getGraduationState();

    expect(await campaign.launched()).to.equal(true);
    expect(await token.tradingEnabled()).to.equal(true);
    expect(state.dexPair).to.equal(poolAddress);
    expect(await pool.stable()).to.equal(false);
    expect(await pool.balanceOf(await lpReceiver.getAddress())).to.equal(state.graduatedLiquidityLp);
    expect(await token.balanceOf(await adapter.getAddress())).to.equal(0n);
    expect(await token.allowance(await adapter.getAddress(), await productionRouter.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await adapter.getAddress())).to.equal(0n);
    expect(await token.allowance(await campaign.getAddress(), await adapter.getAddress())).to.equal(0n);
  });
});
