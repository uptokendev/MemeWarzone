import { expect } from "chai";
import { ethers } from "hardhat";

const FEE = 3000;

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
  deadline: bigint,
) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "bytes32", "address", "address", "uint8", "uint8", "uint64"],
      [
        "MWZ_CREATE_STOCK_ROUTE_AUTH",
        chainId,
        await factory.getAddress(),
        creator,
        hashCampaignRequest(req),
        stockToken,
        adapter,
        1,
        1,
        deadline,
      ],
    ),
  );
  return signer.signMessage(ethers.getBytes(digest));
}

async function fixture() {
  const [owner, creator, routeSigner] = await ethers.getSigners();

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

  const Treasury = await ethers.getContractFactory("MockPhase1TreasuryRouter");
  const treasury = await Treasury.deploy();
  await treasury.waitForDeployment();

  const nativeFeed = await freshFeed("3000");
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

  const locker = await factory.permanentLpLocker();
  const StockAdapter = await ethers.getContractFactory("RobinhoodStockTokenGraduationAdapter");
  const stockAdapter = await StockAdapter.deploy(
    await v3Factory.getAddress(),
    await positionManager.getAddress(),
    await swapRouter.getAddress(),
    await weth.getAddress(),
    locker,
    await nativeFeed.getAddress(),
    FEE,
    3600,
  );
  await stockAdapter.waitForDeployment();
  await stockAdapter.setCampaignFactoryOnce(await factory.getAddress());
  await factory.setStockGraduationAdapter(await stockAdapter.getAddress());

  const Token = await ethers.getContractFactory("MockERC20");
  const stock1 = await Token.deploy("NVIDIA Stock Token", "NVDA", ethers.parseEther("1000000"), await owner.getAddress());
  await stock1.waitForDeployment();
  const stock2 = await Token.deploy("Tesla Stock Token", "TSLA", ethers.parseEther("1000000"), await owner.getAddress());
  await stock2.waitForDeployment();
  const unapproved = await Token.deploy("Unknown Stock", "UNKNOWN", ethers.parseEther("1000000"), await owner.getAddress());
  await unapproved.waitForDeployment();

  const stockFeed1 = await freshFeed("180");
  const stockFeed2 = await freshFeed("250");
  await v3Factory.createPool(await weth.getAddress(), await stock1.getAddress(), FEE);
  await v3Factory.createPool(await weth.getAddress(), await stock2.getAddress(), FEE);
  const pool1 = await v3Factory.getPool(await weth.getAddress(), await stock1.getAddress(), FEE);
  const pool2 = await v3Factory.getPool(await weth.getAddress(), await stock2.getAddress(), FEE);

  for (const [stock, feed, pool] of [
    [stock1, stockFeed1, pool1],
    [stock2, stockFeed2, pool2],
  ] as const) {
    await stockAdapter.configureStockRoute(await stock.getAddress(), {
      oracleFeed: await feed.getAddress(),
      acquisitionPool: pool,
      acquisitionFeeTier: FEE,
      minimumRouteLiquidityUsdWad: 1n,
      maxSwapSlippageBps: 300,
      maxOracleDeviationBps: 300,
      maxPriceImpactBps: 500,
      enabled: true,
    });
  }

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

  return { owner, creator, routeSigner, factory, stockAdapter, stock1, stock2, unapproved, request, locker };
}

describe("Robinhood Stock campaign factory binding", function () {
  it("rejects Stock Tokens that do not have an enabled approved graduation route", async () => {
    const { creator, routeSigner, factory, stockAdapter, unapproved, request } = await fixture();
    const deadline = (await nowTs()) + 3600n;
    const signature = await signStockAuthorization(
      factory,
      await creator.getAddress(),
      routeSigner,
      request,
      await unapproved.getAddress(),
      await stockAdapter.getAddress(),
      deadline,
    );

    await expect(
      factory.connect(creator).createStockCampaignAuthorized(request, await unapproved.getAddress(), {
        tradeRouteProfile: 1,
        finalizeRouteProfile: 1,
        deadline,
        signature,
      }),
    ).to.be.revertedWithCustomError(factory, "UnsupportedStockToken");
  });

  it("cryptographically binds the Stock Token and rejects replay", async () => {
    const { creator, routeSigner, factory, stockAdapter, stock1, stock2, request, locker } = await fixture();
    const deadline = (await nowTs()) + 3600n;
    const signature = await signStockAuthorization(
      factory,
      await creator.getAddress(),
      routeSigner,
      request,
      await stock1.getAddress(),
      await stockAdapter.getAddress(),
      deadline,
    );
    const routeAuth = { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline, signature };

    await expect(
      factory.connect(creator).createStockCampaignAuthorized(request, await stock2.getAddress(), routeAuth),
    ).to.be.revertedWithCustomError(factory, "InvalidRouteAuthorization");

    await expect(
      factory.connect(creator).createStockCampaignAuthorized(request, await stock1.getAddress(), routeAuth),
    ).to.emit(factory, "StockCampaignConfigured");

    const info = await factory.getCampaign(0);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    expect(await factory.campaignGraduationQuoteToken(info.campaign)).to.equal(await stock1.getAddress());
    expect(await campaign.stockGraduationEnabled()).to.equal(true);
    expect(await campaign.graduationQuoteToken()).to.equal(await stock1.getAddress());
    expect(await campaign.stockGraduationAdapter()).to.equal(await stockAdapter.getAddress());

    const permanentLocker = await ethers.getContractAt("PermanentV3PositionLocker", locker);
    expect(await permanentLocker.authorizedIntegrationSource(await stockAdapter.getAddress())).to.equal(true);

    await expect(
      factory.connect(creator).createStockCampaignAuthorized(request, await stock1.getAddress(), routeAuth),
    ).to.be.revertedWithCustomError(factory, "RouteAuthorizationReplayed");
  });
});
