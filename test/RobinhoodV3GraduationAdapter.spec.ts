import { expect } from "chai";
import { ethers } from "hardhat";

const FEE = 3000;
const Q96 = 1n << 96n;

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
  const campaign = Campaign.attach(receipt!.contractAddress!);
  await campaign.initialize(params);
  return campaign;
}

async function deployV3Stack() {
  const WETH = await ethers.getContractFactory("MockWETH9");
  const weth = await WETH.deploy();
  await weth.waitForDeployment();

  const Factory = await ethers.getContractFactory("MockUniswapV3Factory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();

  const PositionManager = await ethers.getContractFactory("MockUniswapV3PositionManager");
  const positionManager = await PositionManager.deploy(await factory.getAddress(), await weth.getAddress());
  await positionManager.waitForDeployment();

  const SwapRouter = await ethers.getContractFactory("MockUniswapV3SwapRouter");
  const swapRouter = await SwapRouter.deploy(await factory.getAddress(), await weth.getAddress());
  await swapRouter.waitForDeployment();
  await factory.configurePeriphery(await positionManager.getAddress(), await swapRouter.getAddress());

  const Adapter = await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter");
  const adapter = await Adapter.deploy(
    await factory.getAddress(),
    await positionManager.getAddress(),
    await weth.getAddress(),
    FEE,
  );
  await adapter.waitForDeployment();

  return { weth, factory, positionManager, swapRouter, adapter };
}

describe("Robinhood V3 graduation compatibility", function () {
  it("graduates the unchanged LaunchCampaign into a permanently locked V3 NFT and harvests fees 80/20", async () => {
    const [owner, creator, buyer, trader, weekly, monthly, protocolVault] = await ethers.getSigners();
    const { weth, factory, positionManager, swapRouter, adapter } = await deployV3Stack();

    const Treasury = await ethers.getContractFactory("TreasuryRouterV2");
    const treasury = await Treasury.deploy(
      await owner.getAddress(),
      await weekly.getAddress(),
      await monthly.getAddress(),
      3600,
    );
    await treasury.waitForDeployment();
    await treasury.setProtocolRevenueVault(await protocolVault.getAddress());

    const Locker = await ethers.getContractFactory("PermanentV3PositionLocker");
    const locker = await Locker.deploy(await owner.getAddress());
    await locker.waitForDeployment();
    await locker.configureRevenue(await treasury.getAddress(), await adapter.getAddress());
    await treasury.setAuthorizedLpLocker(await locker.getAddress(), true);

    const graduationOracle = await deployTestOracle();
    const campaign = await deployDirectCampaign({
      name: "Robinhood Adapter Token",
      symbol: "RHADAPT",
      logoURI: "ipfs://robinhood-adapter",
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
      lpReceiver: await locker.getAddress(),
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
    });

    const token = await ethers.getContractAt("LaunchToken", await campaign.token());
    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);

    await expect(
      campaign.connect(buyer).buyExactTokens(curveSupply, totalBuy, { value: totalBuy })
    ).to.emit(campaign, "CampaignFinalized");

    const state = await campaign.getGraduationState();
    const poolAddress = await factory.getPool(await token.getAddress(), await weth.getAddress(), FEE);
    const pool = await ethers.getContractAt("MockUniswapV3Pool", poolAddress);

    expect(await adapter.liquidityKind()).to.equal(2n);
    expect(await adapter.poolFactory()).to.equal(await adapter.getAddress());
    expect(state.dexPair).to.equal(poolAddress);
    expect(state.graduatedLiquidityLp).to.be.greaterThan(0n);
    expect(await pool.positionTokenId()).to.equal(1n);
    expect(await positionManager.ownerOf(1n)).to.equal(await locker.getAddress());
    expect(await locker.pendingPositionByPool(poolAddress)).to.equal(1n);

    await locker.registerGraduatedPool(
      await campaign.getAddress(),
      await creator.getAddress(),
      await creator.getAddress(),
      poolAddress,
      await token.getAddress(),
      await weth.getAddress(),
      state.graduatedLiquidityLp,
    );

    expect(await locker.registeredLpToken(poolAddress)).to.equal(true);
    expect(await locker.lockedBalance(poolAddress)).to.equal(state.graduatedLiquidityLp);
    expect(await locker.pendingPositionByPool(poolAddress)).to.equal(0n);

    const positionBefore = await positionManager.positions(1n);
    const swapIn = ethers.parseEther("0.001");
    await weth.connect(trader).deposit({ value: swapIn });
    await weth.connect(trader).approve(await swapRouter.getAddress(), swapIn);
    const quoted = await swapRouter.quoteExactInputSingle(await weth.getAddress(), await token.getAddress(), FEE, swapIn);
    expect(quoted).to.be.greaterThan(0n);

    await swapRouter.connect(trader).exactInputSingle({
      tokenIn: await weth.getAddress(),
      tokenOut: await token.getAddress(),
      fee: FEE,
      recipient: await trader.getAddress(),
      amountIn: swapIn,
      amountOutMinimum: quoted,
      sqrtPriceLimitX96: 0,
    });

    const expectedFee = (swapIn * BigInt(FEE)) / 1_000_000n;
    const expectedCreator = (expectedFee * 8_000n) / 10_000n;
    const expectedProtocol = expectedFee - expectedCreator;
    const creatorBefore = await weth.balanceOf(await creator.getAddress());
    const protocolBefore = await weth.balanceOf(await protocolVault.getAddress());

    await locker.connect(trader).harvest(poolAddress);

    expect((await weth.balanceOf(await creator.getAddress())) - creatorBefore).to.equal(expectedCreator);
    expect((await weth.balanceOf(await protocolVault.getAddress())) - protocolBefore).to.equal(expectedProtocol);
    expect(await pool.claimable0()).to.equal(0n);
    expect(await pool.claimable1()).to.equal(0n);
    expect(await positionManager.ownerOf(1n)).to.equal(await locker.getAddress());
    const positionAfter = await positionManager.positions(1n);
    expect(positionAfter.liquidity).to.equal(positionBefore.liquidity);

    await expect(
      positionManager.connect(trader).transferFrom(await locker.getAddress(), await trader.getAddress(), 1n)
    ).to.be.reverted;

    expect(await token.balanceOf(await adapter.getAddress())).to.equal(0n);
    expect(await weth.balanceOf(await adapter.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await adapter.getAddress())).to.equal(0n);
    expect(await token.allowance(await campaign.getAddress(), await adapter.getAddress())).to.equal(0n);
  });

  it("keeps the V3 compatibility boundary fail-closed", async () => {
    const [owner, other] = await ethers.getSigners();
    const { adapter } = await deployV3Stack();

    expect(await adapter.WETH()).to.not.equal(ethers.ZeroAddress);
    await expect(
      adapter.addLiquidityETH(
        await other.getAddress(),
        true,
        1n,
        1n,
        1n,
        await owner.getAddress(),
        (await latestTimestamp()) + 60n,
        { value: 1n },
      )
    ).to.be.revertedWithCustomError(adapter, "StablePoolUnsupported");
  });
});
