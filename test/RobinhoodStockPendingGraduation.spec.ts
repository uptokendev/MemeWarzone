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
  const oracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 30 * 24 * 60 * 60);
  await oracle.waitForDeployment();
  return oracle;
}

async function deployDirectCampaign(factoryAddress: string, routerAddress: string, oracleAddress: string, creator: string) {
  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const impl = await Campaign.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  const minimalProxyBytecode =
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73" + implAddr.slice(2).toLowerCase() + "5af43d82803e903d91602b57fd5bf3";
  const [deployer] = await ethers.getSigners();
  const tx = await deployer.sendTransaction({ data: minimalProxyBytecode });
  const receipt = await tx.wait();
  const campaign = Campaign.attach(receipt!.contractAddress!);
  await campaign.initialize({
    name: "Stock Pending",
    symbol: "SPEND",
    logoURI: "ipfs://stock-pending",
    totalSupply: ethers.parseEther("1000"),
    curveBps: 5000,
    liquidityTokenBps: 4000,
    basePrice: 10n ** 12n,
    priceSlope: 10n ** 9n,
    graduationTarget: 1n,
    graduationOracle: oracleAddress,
    liquidityBps: 8000,
    protocolFeeBps: 0,
    leagueFeeBps: 0,
    leagueReceiver: creator,
    router: routerAddress,
    lpReceiver: creator,
    feeRecipient: creator,
    creator,
    factory: factoryAddress,
    riskRegistry: ethers.ZeroAddress,
    creatorBuyLockUntil: 0n,
    creatorBuyCapWei: 0n,
    requireAuthorizedTrading: false,
    tradeRouteProfile: 1,
    finalizeRouteProfile: 1,
    strictFeeRouting: false,
  });
  return campaign;
}

describe("Robinhood Stock pending graduation lifecycle", function () {
  it("commits the threshold-crossing buy and freezes bonding instead of auto-executing Stock graduation", async () => {
    const [factorySigner, creator, buyer] = await ethers.getSigners();

    const WETH = await ethers.getContractFactory("MockWETH9");
    const weth = await WETH.deploy();
    await weth.waitForDeployment();
    const V3Factory = await ethers.getContractFactory("MockUniswapV3Factory");
    const v3Factory = await V3Factory.deploy();
    await v3Factory.waitForDeployment();
    const PositionManager = await ethers.getContractFactory("MockUniswapV3PositionManager");
    const positionManager = await PositionManager.deploy(await v3Factory.getAddress(), await weth.getAddress());
    await positionManager.waitForDeployment();
    const Router = await ethers.getContractFactory("MockUniswapV3SwapRouter");
    const swapRouter = await Router.deploy(await v3Factory.getAddress(), await weth.getAddress());
    await swapRouter.waitForDeployment();
    await v3Factory.configurePeriphery(await positionManager.getAddress(), await swapRouter.getAddress());

    const NativeAdapter = await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter");
    const nativeAdapter = await NativeAdapter.deploy(
      await v3Factory.getAddress(),
      await positionManager.getAddress(),
      await weth.getAddress(),
      3000,
    );
    await nativeAdapter.waitForDeployment();

    const oracle = await deployTestOracle();
    const campaign = await deployDirectCampaign(
      await factorySigner.getAddress(),
      await nativeAdapter.getAddress(),
      await oracle.getAddress(),
      await creator.getAddress(),
    );

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const stock = await MockERC20.deploy("NVIDIA Stock Token", "NVDA", ethers.parseEther("1000"), await factorySigner.getAddress());
    await stock.waitForDeployment();
    const AdapterMarker = await ethers.getContractFactory("MockRobinhoodStockCampaignFactory");
    const adapterMarker = await AdapterMarker.deploy();
    await adapterMarker.waitForDeployment();

    await expect(campaign.connect(factorySigner).configureStockGraduation(await stock.getAddress(), await adapterMarker.getAddress()))
      .to.emit(campaign, "StockGraduationConfigured");

    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);
    await expect(campaign.connect(buyer).buyExactTokens(curveSupply, totalBuy, { value: totalBuy }))
      .to.emit(campaign, "StockGraduationPending");

    expect(await campaign.graduationPending()).to.equal(true);
    expect(await campaign.launched()).to.equal(false);
    expect(await campaign.sold()).to.equal(curveSupply);
    expect(await campaign.graduationQuoteToken()).to.equal(await stock.getAddress());
    expect(await campaign.pendingGraduationNativeTarget()).to.be.greaterThan(0n);

    await expect(campaign.quoteSellExactTokens(1n)).to.be.revertedWithCustomError(campaign, "GraduationPending");
    await expect(campaign.connect(buyer).sellExactTokens(1n, 0n)).to.be.revertedWithCustomError(campaign, "GraduationPending");
    expect(await campaign.sold()).to.equal(curveSupply);
  });

  it("does not allow Stock graduation mode to be attached after bonding starts", async () => {
    const [factorySigner, creator, buyer] = await ethers.getSigners();
    const WETH = await ethers.getContractFactory("MockWETH9");
    const weth = await WETH.deploy();
    await weth.waitForDeployment();
    const V3Factory = await ethers.getContractFactory("MockUniswapV3Factory");
    const v3Factory = await V3Factory.deploy();
    await v3Factory.waitForDeployment();
    const PositionManager = await ethers.getContractFactory("MockUniswapV3PositionManager");
    const positionManager = await PositionManager.deploy(await v3Factory.getAddress(), await weth.getAddress());
    await positionManager.waitForDeployment();
    const NativeAdapter = await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter");
    const nativeAdapter = await NativeAdapter.deploy(await v3Factory.getAddress(), await positionManager.getAddress(), await weth.getAddress(), 3000);
    await nativeAdapter.waitForDeployment();
    const oracle = await deployTestOracle();
    const campaign = await deployDirectCampaign(await factorySigner.getAddress(), await nativeAdapter.getAddress(), await oracle.getAddress(), await creator.getAddress());

    const buyAmount = ethers.parseEther("1");
    const buyCost = await campaign.quoteBuyExactTokens(buyAmount);
    await campaign.connect(buyer).buyExactTokens(buyAmount, buyCost, { value: buyCost });

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const stock = await MockERC20.deploy("Stock", "STK", ethers.parseEther("1000"), await factorySigner.getAddress());
    await stock.waitForDeployment();
    await expect(campaign.connect(factorySigner).configureStockGraduation(await stock.getAddress(), await nativeAdapter.getAddress()))
      .to.be.revertedWithCustomError(campaign, "StockGraduationConfigLocked");
  });
});
