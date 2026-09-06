import { expect } from "chai";
import { ethers } from "hardhat";

const WAD = 10n ** 18n;
const BPS = 10_000n;
const FACTORY_GENERATION = 5;
const QUOTE_CAMPAIGN_GENERATION = 4;

async function nowTs() {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
}

async function setFeed(feed: any, value: bigint, decimals = 8) {
  const now = await nowTs();
  const scaled = value * (10n ** BigInt(decimals));
  await (await feed.setRoundData(1, scaled, now, now, 1)).wait();
}

async function deployCore() {
  const [owner, creator, buyer, other] = await ethers.getSigners();

  const Wbnb = await ethers.getContractFactory("MockWBNB");
  const wbnb = await Wbnb.deploy();
  await wbnb.waitForDeployment();

  const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
  const topazFactory = await TopazFactory.deploy();
  await topazFactory.waitForDeployment();

  const Router = await ethers.getContractFactory("MockBnbQuoteTopazRouter");
  const router = await Router.deploy(await topazFactory.getAddress(), await wbnb.getAddress());
  await router.waitForDeployment();

  const Treasury = await ethers.getContractFactory("MockPhase1TreasuryRouter");
  const treasury = await Treasury.deploy();
  await treasury.waitForDeployment();

  const Feed = await ethers.getContractFactory("MockUsdPriceFeed");
  const nativeFeed = await Feed.deploy(8);
  await nativeFeed.waitForDeployment();
  await setFeed(nativeFeed, 600n);

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const graduationOracle = await GraduationOracle.deploy(await nativeFeed.getAddress(), 3600);
  await graduationOracle.waitForDeployment();

  const NativeCampaign = await ethers.getContractFactory("LaunchCampaign");
  const nativeImpl = await NativeCampaign.deploy();
  await nativeImpl.waitForDeployment();

  const QuoteCampaign = await ethers.getContractFactory("BnbQuoteLaunchCampaign");
  const quoteImpl = await QuoteCampaign.deploy();
  await quoteImpl.waitForDeployment();

  const BasicFactory = await ethers.getContractFactory("BnbBasicLaunchFactory");
  const factory = await BasicFactory.deploy(
    await router.getAddress(),
    await treasury.getAddress(),
    await nativeImpl.getAddress(),
    await graduationOracle.getAddress(),
    await quoteImpl.getAddress(),
  );
  await factory.waitForDeployment();

  await (await factory.setConfig({
    totalSupply: ethers.parseEther("1000000000"),
    curveBps: 8400,
    liquidityTokenBps: 1400,
    basePrice: 1_000_000_000n,
    priceSlope: 850n,
    graduationTarget: ethers.parseEther("60"),
    liquidityBps: 3300,
  })).wait();
  await (await factory.setProtocolFee(200)).wait();
  await (await factory.setRequireAuthorizedTrading(false)).wait();
  await (await factory.setRouteAuthority(await owner.getAddress())).wait();

  return { owner, creator, buyer, other, wbnb, topazFactory, router, treasury, nativeFeed, graduationOracle, nativeImpl, quoteImpl, factory };
}

async function createNativeCampaign(core: Awaited<ReturnType<typeof deployCore>>) {
  const { factory, creator } = core;
  await (await factory.setRequireRouteAuthorization(false)).wait();
  await (await factory.enableLive()).wait();
  const req = {
    name: "Native Meme",
    symbol: "NATIVE",
    logoURI: "ipfs://native",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: ethers.parseEther("60"),
  };
  await (await factory.connect(creator).createCampaign(req)).wait();
  const info = await factory.getCampaign(0);
  return {
    campaign: await ethers.getContractAt("LaunchCampaign", info.campaign),
    token: await ethers.getContractAt("LaunchToken", info.token),
  };
}

async function signBasicQuoteCreate(core: Awaited<ReturnType<typeof deployCore>>, req: any, quoteToken: string, deadline: bigint) {
  const { owner, creator, factory, quoteImpl } = core;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const reqHash = ethers.keccak256(coder.encode(
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
  ));

  const payloadHash = ethers.keccak256(coder.encode(
    ["string", "uint256", "address", "address", "bytes32", "address", "address", "address", "uint32", "uint32", "uint8", "uint8", "uint64"],
    [
      "MWZ_CREATE_BNB_BASIC_QUOTE_AUTH",
      (await ethers.provider.getNetwork()).chainId,
      await factory.getAddress(),
      await creator.getAddress(),
      reqHash,
      quoteToken,
      await factory.bnbQuoteGraduationAdapter(),
      await quoteImpl.getAddress(),
      FACTORY_GENERATION,
      QUOTE_CAMPAIGN_GENERATION,
      1,
      1,
      deadline,
    ],
  ));

  return owner.signMessage(ethers.getBytes(payloadHash));
}

async function createQuoteCampaign(core: Awaited<ReturnType<typeof deployCore>>, disableRoute = false) {
  const { owner, creator, factory, topazFactory, router, nativeFeed } = core;

  const Token = await ethers.getContractFactory("MockERC20");
  const quote = await Token.deploy("Canonical USD", "cUSD", ethers.parseEther("20000000"), await owner.getAddress());
  await quote.waitForDeployment();

  const Feed = await ethers.getContractFactory("MockUsdPriceFeed");
  const quoteFeed = await Feed.deploy(8);
  await quoteFeed.waitForDeployment();
  await setFeed(nativeFeed, 600n);
  await setFeed(quoteFeed, 1n);

  const acquisitionPoolAddress = await topazFactory.createPool.staticCall(await core.wbnb.getAddress(), await quote.getAddress(), false);
  await (await topazFactory.createPool(await core.wbnb.getAddress(), await quote.getAddress(), false)).wait();
  const acquisitionPool = await ethers.getContractAt("MockTopazPool", acquisitionPoolAddress);

  const reserveWbnb = ethers.parseEther("10000");
  const reserveQuote = ethers.parseEther("6000000");
  const token0 = await acquisitionPool.token0();
  if (token0.toLowerCase() === (await core.wbnb.getAddress()).toLowerCase()) {
    await (await acquisitionPool.setReserves(reserveWbnb, reserveQuote)).wait();
  } else {
    await (await acquisitionPool.setReserves(reserveQuote, reserveWbnb)).wait();
  }
  await (await quote.transfer(await router.getAddress(), reserveQuote)).wait();

  const Adapter = await ethers.getContractFactory("BnbQuoteGraduationAdapter");
  const adapter = await Adapter.deploy(
    await router.getAddress(),
    await factory.permanentLpLocker(),
    await nativeFeed.getAddress(),
    3600,
  );
  await adapter.waitForDeployment();
  await (await adapter.setCampaignFactoryOnce(await factory.getAddress())).wait();

  const route = {
    oracleFeed: await quoteFeed.getAddress(),
    acquisitionPool: acquisitionPoolAddress,
    minimumRouteLiquidityUsdWad: ethers.parseEther("1000000"),
    maxSwapSlippageBps: 200,
    maxOracleDeviationBps: 200,
    maxPriceImpactBps: 200,
    maxGraduationPriceDeviationBps: 200,
    enabled: true,
  };
  await (await adapter.configureQuoteRoute(await quote.getAddress(), route)).wait();
  await (await factory.setBnbQuoteGraduationAdapter(await adapter.getAddress())).wait();
  await (await factory.enableLive()).wait();

  const req = {
    name: "Stable Meme",
    symbol: "STABLE",
    logoURI: "ipfs://stable",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: ethers.parseEther("60"),
  };
  const deadline = (await nowTs()) + 3600n;
  const signature = await signBasicQuoteCreate(core, req, await quote.getAddress(), deadline);
  await (await factory.connect(creator).createBasicQuoteCampaignAuthorized(
    req,
    await quote.getAddress(),
    { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline, signature },
  )).wait();

  const info = await factory.getCampaign(0);
  const campaign = await ethers.getContractAt("BnbQuoteLaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);

  if (disableRoute) {
    await (await adapter.configureQuoteRoute(await quote.getAddress(), { ...route, enabled: false })).wait();
  }

  return { quote, quoteFeed, acquisitionPool, adapter, campaign, token };
}

async function crossThreshold(campaign: any, buyer: any) {
  await (await campaign.connect(buyer).buyExactBnb(0, { value: ethers.parseEther("0.11") })).wait();
  expect(await campaign.graduationPending()).to.equal(true);
  expect(await campaign.launched()).to.equal(false);
}

describe("BNB BASIC graduation market", function () {
  this.timeout(180_000);

  it("preserves native BNB -> MEME/WBNB graduation and permanent locking", async function () {
    const core = await deployCore();
    const { campaign, token } = await createNativeCampaign(core);

    await (await campaign.connect(core.buyer).buyExactBnb(0, { value: ethers.parseEther("0.11") })).wait();
    expect(await campaign.launched()).to.equal(true);
    expect(await campaign.graduationPending()).to.equal(false);

    const state = await campaign.getGraduationState();
    const pair = state[0];
    expect(pair).to.not.equal(ethers.ZeroAddress);
    expect(pair).to.equal(await core.topazFactory.getPool(await token.getAddress(), await core.wbnb.getAddress(), false));

    const locker = await ethers.getContractAt("PermanentLpLocker", await core.factory.permanentLpLocker());
    expect(await locker.registeredLpToken(pair)).to.equal(true);
    expect(await locker.lockedBalance(pair)).to.be.gt(0n);
  });

  it("graduates an approved stable quote through fresh Topaz route checks and preserves locker fee economics", async function () {
    const core = await deployCore();
    const { quote, campaign, token } = await createQuoteCampaign(core);
    await crossThreshold(campaign, core.buyer);

    const stateBefore = await campaign.getGraduationState();
    const graduationBalance = stateBefore[9];
    const finalCurvePrice = stateBefore[1];
    const protocolFee = (graduationBalance * 200n) / BPS;
    const liquidityValue = ((graduationBalance - protocolFee) * 3300n) / BPS;
    let memeDesired = (liquidityValue * WAD) / finalCurvePrice;
    const liquiditySupply = await campaign.liquiditySupply();
    let actualLiquidityValue = liquidityValue;
    if (memeDesired > liquiditySupply) {
      memeDesired = liquiditySupply;
      actualLiquidityValue = (memeDesired * finalCurvePrice) / WAD;
    }

    const route = [{ from: await core.wbnb.getAddress(), to: await quote.getAddress(), stable: false, factory: await core.topazFactory.getAddress() }];
    const quoted = await core.router.getAmountsOut(actualLiquidityValue, route);
    const minimumQuoteOut = (quoted[1] * 99n) / 100n;
    const minimumMemeUsed = (memeDesired * 99n) / 100n;
    const deadline = (await nowTs()) + 3600n;

    await (await core.factory.completeBasicQuoteGraduation(
      await campaign.getAddress(), minimumMemeUsed, minimumQuoteOut, deadline,
    )).wait();

    expect(await campaign.launched()).to.equal(true);
    expect(await campaign.graduationPending()).to.equal(false);
    const state = await campaign.getGraduationState();
    const pairAddress = state[0];
    expect(pairAddress).to.equal(await core.topazFactory.getPool(await token.getAddress(), await quote.getAddress(), false));
    expect(await core.topazFactory.getPool(await token.getAddress(), await core.wbnb.getAddress(), false)).to.equal(ethers.ZeroAddress);

    const locker = await ethers.getContractAt("PermanentLpLocker", await core.factory.permanentLpLocker());
    const principalBefore = await locker.lockedBalance(pairAddress);
    expect(principalBefore).to.be.gt(0n);

    const pair = await ethers.getContractAt("MockTopazPool", pairAddress);
    const feeAmount = ethers.parseEther("100");
    await (await quote.approve(pairAddress, feeAmount)).wait();
    const token0 = await pair.token0();
    const quoteIs0 = token0.toLowerCase() === (await quote.getAddress()).toLowerCase();
    await (await pair.fundFees(await locker.getAddress(), quoteIs0 ? feeAmount : 0n, quoteIs0 ? 0n : feeAmount)).wait();

    const creatorBefore = await quote.balanceOf(await core.creator.getAddress());
    await (await locker.harvest(pairAddress)).wait();
    const creatorAfter = await quote.balanceOf(await core.creator.getAddress());
    expect(creatorAfter - creatorBefore).to.equal((feeAmount * 8000n) / BPS);
    expect(await core.treasury.lpTokenReceived(await quote.getAddress())).to.equal((feeAmount * 2000n) / BPS);
    expect(await locker.lockedBalance(pairAddress)).to.equal(principalBefore);
  });

  it("keeps an unsafe/disabled quote graduation pending with no silent WBNB fallback", async function () {
    const core = await deployCore();
    const { campaign, token, quote } = await createQuoteCampaign(core, true);
    await crossThreshold(campaign, core.buyer);

    await expect(core.factory.completeBasicQuoteGraduation(
      await campaign.getAddress(), 1n, 1n, (await nowTs()) + 3600n,
    )).to.be.revertedWithCustomError(await ethers.getContractAt("BnbQuoteGraduationAdapter", await core.factory.bnbQuoteGraduationAdapter()), "RouteDisabled");

    expect(await campaign.graduationPending()).to.equal(true);
    expect(await campaign.launched()).to.equal(false);
    expect(await core.topazFactory.getPool(await token.getAddress(), await quote.getAddress(), false)).to.equal(ethers.ZeroAddress);
    expect(await core.topazFactory.getPool(await token.getAddress(), await core.wbnb.getAddress(), false)).to.equal(ethers.ZeroAddress);
  });
});
