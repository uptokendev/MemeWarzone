import { expect } from "chai";
import { ethers } from "hardhat";

const FEE = 3000;
const BPS = 10_000n;
const CREATOR_FEE_BPS = 8_000n;

async function nowTs() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function freshFeed(price: string) {
  const Feed = await ethers.getContractFactory("MockUsdPriceFeed");
  const feed = await Feed.deploy(8);
  await feed.waitForDeployment();
  const now = await nowTs();
  await feed.setRoundData(1n, ethers.parseUnits(price, 8), now, now, 1n);
  return feed;
}

function hashCampaignRequest(req: any) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256"],
      [
        ethers.keccak256(ethers.toUtf8Bytes(req.name)),
        ethers.keccak256(ethers.toUtf8Bytes(req.symbol)),
        ethers.keccak256(ethers.toUtf8Bytes(req.logoURI)),
        ethers.keccak256(ethers.toUtf8Bytes(req.xAccount)),
        ethers.keccak256(ethers.toUtf8Bytes(req.website)),
        ethers.keccak256(ethers.toUtf8Bytes(req.extraLink)),
        req.graduationTarget,
      ],
    ),
  );
}

async function signStockAuthorization(
  factory: any,
  creator: string,
  signer: any,
  req: any,
  stockToken: string,
  adapter: string,
  implementation: string,
  deadline: bigint,
) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "bytes32", "address", "address", "address", "uint8", "uint8", "uint64"],
      [
        "MWZ_CREATE_STOCK_ROUTE_AUTH",
        chainId,
        await factory.getAddress(),
        creator,
        hashCampaignRequest(req),
        stockToken,
        adapter,
        implementation,
        1,
        1,
        deadline,
      ],
    ),
  );
  return signer.signMessage(ethers.getBytes(digest));
}

async function seedAcquisitionLiquidity(
  owner: any,
  weth: any,
  stock: any,
  v3Factory: any,
  positionManager: any,
) {
  const wethAmount = ethers.parseEther("100");
  const stockAmount = ethers.parseEther("3000");
  await weth.connect(owner).deposit({ value: wethAmount });

  const wethAddress = await weth.getAddress();
  const stockAddress = await stock.getAddress();
  const token0 = wethAddress.toLowerCase() < stockAddress.toLowerCase() ? wethAddress : stockAddress;
  const token1 = token0 === wethAddress ? stockAddress : wethAddress;

  await positionManager.createAndInitializePoolIfNecessary(token0, token1, FEE, 2n ** 96n);
  const pool = await v3Factory.getPool(wethAddress, stockAddress, FEE);

  await weth.connect(owner).approve(await positionManager.getAddress(), wethAmount);
  await stock.connect(owner).approve(await positionManager.getAddress(), stockAmount);
  const amount0Desired = token0 === wethAddress ? wethAmount : stockAmount;
  const amount1Desired = token0 === wethAddress ? stockAmount : wethAmount;
  await positionManager.connect(owner).mint({
    token0,
    token1,
    fee: FEE,
    tickLower: -600,
    tickUpper: 600,
    amount0Desired,
    amount1Desired,
    amount0Min: amount0Desired,
    amount1Min: amount1Desired,
    recipient: await owner.getAddress(),
    deadline: (await nowTs()) + 3600n,
  });
  return pool;
}

async function fixture() {
  const [owner, creator, routeSigner, buyer, outsider] = await ethers.getSigners();

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

  const NativeAdapter = await ethers.getContractFactory("RobinhoodUniswapV3GraduationAdapter");
  const nativeAdapter = await NativeAdapter.deploy(
    await v3Factory.getAddress(),
    await positionManager.getAddress(),
    await weth.getAddress(),
    FEE,
  );
  await nativeAdapter.waitForDeployment();

  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const campaignImplementation = await Campaign.deploy();
  await campaignImplementation.waitForDeployment();

  const StockCampaign = await ethers.getContractFactory("RobinhoodStockLaunchCampaign");
  const stockCampaignImplementation = await StockCampaign.deploy();
  await stockCampaignImplementation.waitForDeployment();

  const Treasury = await ethers.getContractFactory("MockPhase1TreasuryRouter");
  const treasury = await Treasury.deploy();
  await treasury.waitForDeployment();

  const nativeFeed = await freshFeed("3000");
  const stockFeed = await freshFeed("100");
  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const graduationOracle = await GraduationOracle.deploy(await nativeFeed.getAddress(), 30 * 24 * 60 * 60);
  await graduationOracle.waitForDeployment();

  const Factory = await ethers.getContractFactory("LaunchFactory");
  const factory = await Factory.deploy(
    await nativeAdapter.getAddress(),
    await treasury.getAddress(),
    await campaignImplementation.getAddress(),
    await graduationOracle.getAddress(),
  );
  await factory.waitForDeployment();
  await factory.setRouteAuthority(await routeSigner.getAddress());
  await factory.setRequireAuthorizedTrading(false);
  await factory.setStockCampaignImplementation(await stockCampaignImplementation.getAddress());

  const lockerAddress = await factory.permanentLpLocker();
  const StockAdapter = await ethers.getContractFactory("RobinhoodStockTokenGraduationAdapter");
  const stockAdapter = await StockAdapter.deploy(
    await v3Factory.getAddress(),
    await positionManager.getAddress(),
    await swapRouter.getAddress(),
    await weth.getAddress(),
    lockerAddress,
    await nativeFeed.getAddress(),
    FEE,
    3600,
  );
  await stockAdapter.waitForDeployment();
  await stockAdapter.setCampaignFactoryOnce(await factory.getAddress());
  await factory.setStockGraduationAdapter(await stockAdapter.getAddress());

  const Token = await ethers.getContractFactory("MockERC20");
  const stock = await Token.deploy(
    "NVIDIA Stock Token",
    "NVDA",
    ethers.parseEther("1000000"),
    await owner.getAddress(),
  );
  await stock.waitForDeployment();

  const acquisitionPool = await seedAcquisitionLiquidity(owner, weth, stock, v3Factory, positionManager);
  const route = {
    oracleFeed: await stockFeed.getAddress(),
    acquisitionPool,
    acquisitionFeeTier: FEE,
    minimumRouteLiquidityUsdWad: ethers.parseEther("1000"),
    maxSwapSlippageBps: 500,
    maxOracleDeviationBps: 500,
    maxPriceImpactBps: 500,
    enabled: true,
  };
  await stockAdapter.configureStockRoute(await stock.getAddress(), route);
  await factory.enableLive();

  const request = {
    name: "NVIDIA War Token",
    symbol: "NVWAR",
    logoURI: "ipfs://nvwar",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: 1n,
  };
  const createDeadline = (await nowTs()) + 3600n;
  const signature = await signStockAuthorization(
    factory,
    await creator.getAddress(),
    routeSigner,
    request,
    await stock.getAddress(),
    await stockAdapter.getAddress(),
    await stockCampaignImplementation.getAddress(),
    createDeadline,
  );
  await factory.connect(creator).createStockCampaignAuthorized(request, await stock.getAddress(), {
    tradeRouteProfile: 1,
    finalizeRouteProfile: 1,
    deadline: createDeadline,
    signature,
  });

  const info = await factory.getCampaign(0);
  const campaign = await ethers.getContractAt("RobinhoodStockLaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);
  const locker = await ethers.getContractAt("PermanentV3PositionLocker", lockerAddress);

  const buyAmount = ethers.parseEther("1");
  const buyCost = await campaign.quoteBuyExactTokens(buyAmount);
  await campaign.connect(buyer).buyExactTokens(buyAmount, buyCost, { value: buyCost });
  expect(await campaign.graduationPending()).to.equal(true);
  expect(await campaign.launched()).to.equal(false);

  return {
    owner,
    creator,
    buyer,
    outsider,
    factory,
    treasury,
    weth,
    v3Factory,
    positionManager,
    swapRouter,
    stock,
    stockFeed,
    stockAdapter,
    route,
    campaign,
    token,
    locker,
  };
}

async function completionBounds(fx: Awaited<ReturnType<typeof fixture>>) {
  const state = await fx.campaign.getGraduationState();
  const graduationBalance = state.graduationBalance;
  const protocolFeeBps = await fx.campaign.protocolFeeBps();
  const liquidityBps = await fx.campaign.liquidityBps();
  const protocolFee = (graduationBalance * protocolFeeBps) / BPS;
  const remainingAfterFee = graduationBalance - protocolFee;
  let liquidityValue = (remainingAfterFee * liquidityBps) / BPS;
  let memeDesired = (liquidityValue * ethers.WeiPerEther) / state.finalCurvePrice;
  const liquiditySupply = await fx.campaign.liquiditySupply();
  if (memeDesired > liquiditySupply) {
    memeDesired = liquiditySupply;
    liquidityValue = (memeDesired * state.finalCurvePrice) / ethers.WeiPerEther;
  }
  const quotedStock = await fx.swapRouter.quoteExactInputSingle(
    await fx.weth.getAddress(),
    await fx.stock.getAddress(),
    FEE,
    liquidityValue,
  );
  const minimumStockOut = (quotedStock * 99n) / 100n;
  return {
    state,
    protocolFee,
    remainingAfterFee,
    liquidityValue,
    memeDesired,
    quotedStock,
    minimumStockOut,
    creatorPayout: remainingAfterFee - liquidityValue,
  };
}

describe("Robinhood Stock pending graduation completion", function () {
  it("keeps the campaign pending after a failed route and completes safely on retry", async () => {
    const fx = await fixture();
    const bounds = await completionBounds(fx);
    const deadline = (await nowTs()) + 3600n;

    await expect(
      fx.campaign.connect(fx.outsider).completeStockGraduation(bounds.memeDesired, bounds.minimumStockOut, deadline),
    ).to.be.revertedWithCustomError(fx.campaign, "OnlyStockGraduationExecutor");

    await fx.stockAdapter.configureStockRoute(await fx.stock.getAddress(), { ...fx.route, enabled: false });
    const treasuryBeforeFailure = await ethers.provider.getBalance(await fx.treasury.getAddress());
    await expect(
      fx.campaign.connect(fx.owner).completeStockGraduation(bounds.memeDesired, bounds.minimumStockOut, deadline),
    ).to.be.revertedWithCustomError(fx.stockAdapter, "RouteDisabled");

    expect(await fx.campaign.graduationPending()).to.equal(true);
    expect(await fx.campaign.launched()).to.equal(false);
    expect(await fx.token.tradingEnabled()).to.equal(false);
    expect(await fx.factory.campaignGraduationRecorded(await fx.campaign.getAddress())).to.equal(false);
    expect(await ethers.provider.getBalance(await fx.treasury.getAddress())).to.equal(treasuryBeforeFailure);

    await fx.stockAdapter.configureStockRoute(await fx.stock.getAddress(), fx.route);
    const creatorBefore = await ethers.provider.getBalance(await fx.creator.getAddress());
    const treasuryBefore = await ethers.provider.getBalance(await fx.treasury.getAddress());

    await expect(
      fx.campaign.connect(fx.owner).completeStockGraduation(bounds.memeDesired, bounds.minimumStockOut, deadline),
    ).to.emit(fx.campaign, "StockGraduationCompleted");

    expect(await fx.campaign.graduationPending()).to.equal(false);
    expect(await fx.campaign.launched()).to.equal(true);
    expect(await fx.token.tradingEnabled()).to.equal(true);
    expect(await fx.factory.campaignGraduationRecorded(await fx.campaign.getAddress())).to.equal(true);
    expect(await fx.campaign.stockFinalCurveMemeUsdWad()).to.be.greaterThan(0n);
    expect(await fx.campaign.stockInitialDexMemeUsdWad()).to.be.greaterThan(0n);

    const pool = await fx.v3Factory.getPool(await fx.token.getAddress(), await fx.stock.getAddress(), FEE);
    expect(pool).to.not.equal(ethers.ZeroAddress);
    expect(await fx.locker.registeredLpToken(pool)).to.equal(true);

    const tokenId = await fx.campaign.stockPositionTokenId();
    expect(tokenId).to.be.greaterThan(0n);
    expect(await fx.positionManager.ownerOf(tokenId)).to.equal(await fx.locker.getAddress());
    const poolInfo = await fx.locker.poolInfo(pool);
    expect(poolInfo.tokenId).to.equal(tokenId);
    const pair = [poolInfo.token0.toLowerCase(), poolInfo.token1.toLowerCase()].sort();
    expect(pair).to.deep.equal([
      (await fx.token.getAddress()).toLowerCase(),
      (await fx.stock.getAddress()).toLowerCase(),
    ].sort());

    expect(await fx.stock.balanceOf(await fx.stockAdapter.getAddress())).to.equal(0n);
    expect(await fx.token.balanceOf(await fx.stockAdapter.getAddress())).to.equal(0n);
    expect(await fx.stock.balanceOf(await fx.campaign.getAddress())).to.equal(0n);

    const creatorAfter = await ethers.provider.getBalance(await fx.creator.getAddress());
    const treasuryAfter = await ethers.provider.getBalance(await fx.treasury.getAddress());
    expect(creatorAfter - creatorBefore).to.equal(bounds.creatorPayout);
    expect(treasuryAfter - treasuryBefore).to.equal(bounds.protocolFee);

    const finalState = await fx.campaign.getGraduationState();
    expect(finalState.graduatedLiquidityBnb).to.equal(bounds.liquidityValue);
    expect(finalState.graduatedLiquidityTokens).to.equal(bounds.memeDesired);
    expect(finalState.initialDexPrice).to.equal(0n);

    // RH-S8: generate fees in both pool assets, harvest only fees, and prove the NFT
    // principal / V3 liquidity are unchanged. The creator gets 80%; protocol gets 20%.
    const memeSwapIn = finalState.graduatedLiquidityTokens / 10n;
    expect(memeSwapIn).to.be.greaterThan(0n);
    await fx.token.connect(fx.buyer).approve(await fx.swapRouter.getAddress(), memeSwapIn);
    const stockBeforeSwap = await fx.stock.balanceOf(await fx.buyer.getAddress());
    await fx.swapRouter.connect(fx.buyer).exactInputSingle({
      tokenIn: await fx.token.getAddress(),
      tokenOut: await fx.stock.getAddress(),
      fee: FEE,
      recipient: await fx.buyer.getAddress(),
      amountIn: memeSwapIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    });
    const stockReceived = (await fx.stock.balanceOf(await fx.buyer.getAddress())) - stockBeforeSwap;
    expect(stockReceived).to.be.greaterThan(1n);

    const stockSwapIn = stockReceived / 2n;
    await fx.stock.connect(fx.buyer).approve(await fx.swapRouter.getAddress(), stockSwapIn);
    await fx.swapRouter.connect(fx.buyer).exactInputSingle({
      tokenIn: await fx.stock.getAddress(),
      tokenOut: await fx.token.getAddress(),
      fee: FEE,
      recipient: await fx.buyer.getAddress(),
      amountIn: stockSwapIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    });

    const graduatedPool = await ethers.getContractAt("MockUniswapV3Pool", pool);
    const claimable0 = await graduatedPool.claimable0();
    const claimable1 = await graduatedPool.claimable1();
    expect(claimable0).to.be.greaterThan(0n);
    expect(claimable1).to.be.greaterThan(0n);

    const tokenAddress = (await fx.token.getAddress()).toLowerCase();
    const token0Contract = poolInfo.token0.toLowerCase() === tokenAddress ? fx.token : fx.stock;
    const token1Contract = poolInfo.token1.toLowerCase() === tokenAddress ? fx.token : fx.stock;
    const creatorAddress = await fx.creator.getAddress();
    const treasuryAddress = await fx.treasury.getAddress();

    const creator0Before = await token0Contract.balanceOf(creatorAddress);
    const creator1Before = await token1Contract.balanceOf(creatorAddress);
    const treasury0Before = await token0Contract.balanceOf(treasuryAddress);
    const treasury1Before = await token1Contract.balanceOf(treasuryAddress);
    const positionBefore = await fx.positionManager.positions(tokenId);
    const lockedBefore = await fx.locker.lockedBalance(pool);

    await expect(fx.locker.connect(fx.outsider).harvest(pool)).to.emit(fx.locker, "FeesHarvested");

    const expectedCreator0 = (claimable0 * CREATOR_FEE_BPS) / BPS;
    const expectedCreator1 = (claimable1 * CREATOR_FEE_BPS) / BPS;
    const expectedProtocol0 = claimable0 - expectedCreator0;
    const expectedProtocol1 = claimable1 - expectedCreator1;

    expect((await token0Contract.balanceOf(creatorAddress)) - creator0Before).to.equal(expectedCreator0);
    expect((await token1Contract.balanceOf(creatorAddress)) - creator1Before).to.equal(expectedCreator1);
    expect((await token0Contract.balanceOf(treasuryAddress)) - treasury0Before).to.equal(expectedProtocol0);
    expect((await token1Contract.balanceOf(treasuryAddress)) - treasury1Before).to.equal(expectedProtocol1);
    expect(await fx.treasury.lpTokenReceived(poolInfo.token0)).to.equal(expectedProtocol0);
    expect(await fx.treasury.lpTokenReceived(poolInfo.token1)).to.equal(expectedProtocol1);

    expect(await graduatedPool.claimable0()).to.equal(0n);
    expect(await graduatedPool.claimable1()).to.equal(0n);
    expect(await fx.positionManager.ownerOf(tokenId)).to.equal(await fx.locker.getAddress());
    const positionAfter = await fx.positionManager.positions(tokenId);
    expect(positionAfter.liquidity).to.equal(positionBefore.liquidity);
    expect(await fx.locker.lockedBalance(pool)).to.equal(lockedBefore);
    expect(lockedBefore).to.equal(poolInfo.lockedLiquidity);
  });
});
