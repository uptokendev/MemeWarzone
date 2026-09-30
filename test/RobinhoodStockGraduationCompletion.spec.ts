import { expect } from "chai";
import { ethers } from "hardhat";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";
import { installRealV3, RH_V3, seedFullRangePool } from "./helpers/evmgenRhRealV3";
import { mineAt, buyNative } from "./fixtures/evmgenCore";

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
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "uint256", "uint256", "uint8", "uint8"],
      [
        ethers.keccak256(ethers.toUtf8Bytes(req.name)),
        ethers.keccak256(ethers.toUtf8Bytes(req.symbol)),
        ethers.keccak256(ethers.toUtf8Bytes(req.logoURI)),
        ethers.keccak256(ethers.toUtf8Bytes(req.xAccount)),
        ethers.keccak256(ethers.toUtf8Bytes(req.website)),
        ethers.keccak256(ethers.toUtf8Bytes(req.extraLink)),
        req.graduationTarget, req.firstBuyTokens ?? 0n, req.firstBuyMaxCost ?? 0n, req.feeChoice ?? 1, req.feeCreatorPct ?? 0,
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
  const factory = await (await deployFactoryWithLocker({ factoryName: "LaunchFactory", args: [await nativeAdapter.getAddress(),
    await treasury.getAddress(),
    await campaignImplementation.getAddress(),
    await graduationOracle.getAddress()] })).factory;
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
    maxOracleDeviationBps: 0,
    maxPriceImpactBps: 0,
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
    firstBuyTokens: 0n,
    firstBuyMaxCost: 0n,
    feeChoice: 1,
    feeCreatorPct: 0,
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
  // Was pending ("BLOCKED ON claude/evm-rh"). Now against the real stock adapter
  // (RobinhoodStockGraduationAdapterV2), real Uniswap V3 bytecode (canonical 4663 addresses: factory, NPM,
  // SwapRouter02) and the C5 RobinhoodStockLaunchCampaign. graduate() is permissionless; a failed route
  // leaves the campaign Pending with nothing moved, and the retry completes without reverting on dust.
  it("keeps the campaign pending after a failed route and completes safely on retry (RobinhoodStockGraduationAdapterV2)", async () => {
    const [owner, creator, alice, bob, authority, carol] = await ethers.getSigners();
    const v3 = await installRealV3();
    const ethFeed = await freshFeed("2694");
    const spyFeed = await freshFeed("766");
    const spy = await (await ethers.getContractFactory("MockERC20")).deploy("SPY", "SPY", ethers.parseEther("1000000"), owner.address);
    await v3.weth.connect(owner).deposit({ value: ethers.parseEther("1000") });
    await seedFullRangePool(owner, v3.weth, spy, 500, ethers.parseEther("1000"), (ethers.parseEther("1000") * 2694n) / 766n);
    const acquisitionPool = await v3.v3Factory.getPool(RH_V3.weth, await spy.getAddress(), 500);

    const receiver = await (await ethers.getContractFactory("AcceptingReceiver")).deploy();
    const locker = await (await ethers.getContractFactory("PermanentV3PositionLocker")).deploy(owner.address);
    const native = await (await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2")).deploy(RH_V3.v3Factory, RH_V3.positionManager, RH_V3.weth);
    const adapter = await (await ethers.getContractFactory("RobinhoodStockGraduationAdapterV2")).deploy(
      RH_V3.v3Factory, RH_V3.positionManager, RH_V3.swapRouter02, RH_V3.weth, await ethFeed.getAddress(), 90_000,
    );
    await locker.configureRevenue(await receiver.getAddress(), await native.getAddress());
    await locker.setIntegrationSourceAuthorized(await adapter.getAddress(), true);
    const registry = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(await locker.getAddress());
    await adapter.setCampaignFactoryOnce(await registry.getAddress());
    const route = {
      oracleFeed: await spyFeed.getAddress(),
      acquisitionPool,
      acquisitionFeeTier: 500,
      minimumRouteLiquidityUsdWad: ethers.parseEther("50000"),
      maxSwapSlippageBps: 300,
      maxOracleDeviationBps: 0,
      maxPriceImpactBps: 0,
      enabled: true,
    };
    await adapter.configureStockRoute(await spy.getAddress(), route);

    // The C5 stock campaign, driven by the core's stand-in factory.
    const oracle = await (await ethers.getContractFactory("GraduationOracle")).deploy(await ethFeed.getAddress(), 1_000_000_000);
    const tokenDeployer = await (await ethers.getContractFactory("LaunchTokenDeployer")).deploy();
    const router = await (await ethers.getContractFactory("MockTreasuryRouterEvmGen")).deploy();
    const launchFactory = await (await ethers.getContractFactory("MockLaunchFactoryEvmGen")).deploy();
    await launchFactory.setRouteAuthority(authority.address);
    const impl = await (await ethers.getContractFactory("RobinhoodStockLaunchCampaign")).deploy();
    const params = {
      name: "Stock", symbol: "STK", logoURI: "ipfs://s",
      totalSupply: ethers.parseEther("1000000000"), curveBps: 7000, liquidityTokenBps: 2800,
      basePrice: 1_000_000_000n, priceSlope: 850n, graduationTarget: ethers.parseEther("30000"),
      graduationOracle: await oracle.getAddress(), protocolFeeBps: 200,
      graduationAdapter: await native.getAddress(), feeRecipient: await router.getAddress(),
      creator: creator.address, factory: ethers.ZeroAddress, riskRegistry: ethers.ZeroAddress,
      tokenDeployer: await tokenDeployer.getAddress(), creatorBuyCapWei: 0n, requireAuthorizedTrading: true,
      tradeRouteProfile: 1, finalizeRouteProfile: 1,
    };
    const campaignAddress = await launchFactory.create.staticCall(await impl.getAddress(), params);
    await launchFactory.create(await impl.getAddress(), params);
    const campaign = await ethers.getContractAt("RobinhoodStockLaunchCampaign", campaignAddress);
    const token = await ethers.getContractAt("LaunchToken", await campaign.token());
    await launchFactory.configure(campaignAddress, await spy.getAddress(), await adapter.getAddress());
    await registry.setCampaign(campaignAddress, true);

    await mineAt(Number(await campaign.launchAt()) + 120);
    for (let i = 0; i < 20 && !(await campaign.graduationPending()); i++) {
      await buyNative({ authority } as any, campaign, alice, ethers.parseEther("2"));
    }
    expect(await campaign.graduationPending()).to.equal(true);
    const balanceBefore = await ethers.provider.getBalance(campaignAddress);

    // Route disabled: the permissionless graduate() reverts, nothing moves, the coin stays Pending.
    await adapter.configureStockRoute(await spy.getAddress(), { ...route, enabled: false });
    await expect(campaign.connect(bob).graduate()).to.be.revertedWithCustomError(adapter, "RouteDisabled");
    expect(await campaign.graduationPending()).to.equal(true);
    expect(await campaign.launched()).to.equal(false);
    expect(await ethers.provider.getBalance(campaignAddress)).to.equal(balanceBefore);

    // Stale stock feed: same, retryable.
    await adapter.configureStockRoute(await spy.getAddress(), route);
    const t = await nowTs();
    await spyFeed.setRoundData(2n, ethers.parseUnits("766", 8), t - 95_000n, t - 95_000n, 2n);
    await expect(campaign.connect(bob).graduate()).to.be.revertedWithCustomError(adapter, "OracleStale");
    expect(await campaign.graduationPending()).to.equal(true);

    // Fresh round: anyone completes it.
    const t2 = await nowTs();
    await spyFeed.setRoundData(3n, ethers.parseUnits("766", 8), t2, t2, 3n);
    await campaign.connect(carol).graduate();
    expect(await campaign.launched()).to.equal(true);

    const state = await campaign.getGraduationState();
    const pool = state.dexPair;
    expect(pool).to.equal(await v3.v3Factory.getPool(await token.getAddress(), await spy.getAddress(), FEE));
    const tokenId = await locker.pendingPositionByPool(pool);
    expect(tokenId).to.not.equal(0n);
    expect(await v3.positionManager.ownerOf(tokenId)).to.equal(await locker.getAddress());
    expect(await launchFactory.lastNotifiedPool()).to.equal(pool);
    // USD continuity held (the adapter enforces 200 bps, E11): start (SPY per MEME) x SPYUSD vs P x ETHUSD.
    const startUsd = (state.initialDexPrice * 766n) / 1n;
    const curveUsd = state.finalCurvePrice * 2694n;
    const dev = startUsd > curveUsd ? startUsd - curveUsd : curveUsd - startUsd;
    expect(dev * BPS).to.be.lte(curveUsd * 200n);
    // Nothing stranded on the adapter; the campaign kept no MEME; residual SPY is the creator's pull balance.
    for (const t0 of [token, spy, v3.weth]) expect(await (t0 as any).balanceOf(await adapter.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await adapter.getAddress())).to.equal(0n);
    expect(await token.balanceOf(campaignAddress)).to.equal(0n);
    expect(await spy.balanceOf(campaignAddress)).to.equal(await campaign.pendingCreatorQuote());
  });
});
