import { expect } from "chai";
import { ethers, network } from "hardhat";

const ADAPTER = "0x5c3135Dfaad519A9114DEa2E546f0Cd051d0D35a";
const TOPAZ_ROUTER = "0x1E98c8226e7d452e1888e3d3d2F929346321c6c3";
const TOPAZ_FACTORY = "0x65E6cD0eF5D3467030103cf3d433034E570b5784";
const WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const VALID_BNB_TARGET_USD = ethers.parseEther("15000");
const FORK_BNB_USD = ethers.parseUnits("1500000", 8); // fork-only: makes $15k target ~0.01 BNB
const CREATOR_SHARE_BPS = 8000n;
const BPS = 10000n;

const EXEC_ROUTER_ABI = [
  "function defaultFactory() view returns (address)",
  "function weth() view returns (address)",
  "function getAmountsOut(uint256 amountIn,(address from,address dest,bool stable,address factory)[] routes) view returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin,(address from,address dest,bool stable,address factory)[] routes,address recipient,uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,(address from,address dest,bool stable,address factory)[] routes,address recipient,uint256 deadline) returns (uint256[] amounts)",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,(address from,address dest,bool stable,address factory)[] routes,address recipient,uint256 deadline)",
];

const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function stable() view returns (bool)",
  "function factory() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function claimable0(address) view returns (uint256)",
  "function claimable1(address) view returns (uint256)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

function forkEnabled() {
  return ["1", "true", "yes", "on"].includes(String(process.env.BNB_FORK || "").trim().toLowerCase());
}

async function latestTimestamp() {
  return BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
}

async function deploySourceHead() {
  const [owner, creator, buyer] = await ethers.getSigners();
  await network.provider.send("hardhat_setBalance", [await owner.getAddress(), "0x56BC75E2D63100000"]);
  await network.provider.send("hardhat_setBalance", [await creator.getAddress(), "0x8AC7230489E80000"]);
  await network.provider.send("hardhat_setBalance", [await buyer.getAddress(), "0x56BC75E2D63100000"]);

  const topazFactory = new ethers.Contract(TOPAZ_FACTORY, ["function getFee(address,bool) view returns (uint256)"], ethers.provider);
  expect(await topazFactory.getFee(ethers.ZeroAddress, false)).to.equal(30n);

  const adapter = new ethers.Contract(
    ADAPTER,
    ["function topazRouter() view returns (address)", "function poolFactory() view returns (address)", "function WETH() view returns (address)"],
    ethers.provider,
  );
  expect(await adapter.topazRouter()).to.equal(TOPAZ_ROUTER);
  expect(await adapter.poolFactory()).to.equal(TOPAZ_FACTORY);
  expect(await adapter.WETH()).to.equal(WBNB);

  const PriceFeed = await ethers.getContractFactory("MockUsdPriceFeed");
  const priceFeed = await PriceFeed.deploy(8);
  await priceFeed.waitForDeployment();
  const now = await latestTimestamp();
  await (await priceFeed.setRoundData(1n, FORK_BNB_USD, now, now, 1n)).wait();

  const GraduationOracle = await ethers.getContractFactory("GraduationOracle");
  const oracle = await GraduationOracle.deploy(await priceFeed.getAddress(), 86400);
  await oracle.waitForDeployment();

  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const monthly = await Receiver.deploy();
  const recruiter = await Receiver.deploy();
  await Promise.all([weekly.waitForDeployment(), monthly.waitForDeployment(), recruiter.waitForDeployment()]);

  const Treasury = await ethers.getContractFactory("TreasuryRouterV3");
  const treasury = await Treasury.deploy(await owner.getAddress(), await weekly.getAddress(), await monthly.getAddress(), 3600);
  await treasury.waitForDeployment();

  const Community = await ethers.getContractFactory("CommunityRewardsVaultV3Mock");
  const community = await Community.deploy();
  await community.waitForDeployment();
  const Protocol = await ethers.getContractFactory("ProtocolRevenueVault");
  const protocol = await Protocol.deploy(await owner.getAddress());
  await protocol.waitForDeployment();
  const CreatorVault = await ethers.getContractFactory("CreatorRewardsVault");
  const creatorVault = await CreatorVault.deploy(await owner.getAddress(), await treasury.getAddress());
  await creatorVault.waitForDeployment();

  await (await treasury.setRecruiterRewardsVault(await recruiter.getAddress())).wait();
  await (await treasury.setCommunityRewardsVault(await community.getAddress())).wait();
  await (await treasury.setProtocolRevenueVault(await protocol.getAddress())).wait();
  await (await treasury.setCreatorRewardsVault(await creatorVault.getAddress())).wait();

  const Campaign = await ethers.getContractFactory("LaunchCampaign");
  const implementation = await Campaign.deploy();
  await implementation.waitForDeployment();

  const Factory = await ethers.getContractFactory("LaunchFactory");
  const factory = await Factory.deploy(ADAPTER, await treasury.getAddress(), await implementation.getAddress(), await oracle.getAddress());
  await factory.waitForDeployment();
  const locker = await ethers.getContractAt("PermanentLpLocker", await factory.permanentLpLocker());
  await (await treasury.setAuthorizedLpLocker(await locker.getAddress(), true)).wait();
  await (await treasury.setPrimaryLpLocker(await locker.getAddress())).wait();

  expect(await factory.FACTORY_GENERATION()).to.equal(4n);
  expect(await factory.CAMPAIGN_GENERATION()).to.equal(3n);
  expect(await factory.liquidityKind()).to.equal(1n);
  expect(await locker.REQUIRED_POOL_FEE_BPS()).to.equal(30n);
  expect(await locker.CREATOR_FEE_BPS()).to.equal(8000n);
  expect(await locker.PROTOCOL_FEE_BPS()).to.equal(2000n);
  expect(await locker.topazFactory()).to.equal(TOPAZ_FACTORY);
  expect(await factory.isGraduationTargetAllowedForChain(56, VALID_BNB_TARGET_USD)).to.equal(true);
  expect(await factory.isGraduationTargetAllowedForChain(56, ethers.parseEther("6"))).to.equal(false);

  await (await factory.setRequireRouteAuthorization(false)).wait();
  await (await factory.setRequireAuthorizedTrading(false)).wait();
  const cfg = await factory.config();
  await (
    await factory.setConfig({
      totalSupply: cfg.totalSupply,
      curveBps: cfg.curveBps,
      liquidityTokenBps: cfg.liquidityTokenBps,
      basePrice: cfg.basePrice,
      priceSlope: cfg.priceSlope,
      graduationTarget: VALID_BNB_TARGET_USD,
      liquidityBps: cfg.liquidityBps,
    })
  ).wait();
  await (await factory.enableLive()).wait();

  return { owner, creator, buyer, topazFactory, treasury, protocol, creatorVault, factory, locker };
}

describe("BNB source-head 4/3 + V3 fee stack on real Topaz mainnet fork", function () {
  it("creates, routes creator fees, graduates to real 30-bps Topaz, trades, harvests 80/20, and preserves LP", async function () {
    if (!forkEnabled()) this.skip();
    this.timeout(600_000);

    expect(Number((await ethers.provider.getNetwork()).chainId)).to.equal(56);
    const { creator, buyer, topazFactory, treasury, protocol, creatorVault, factory, locker } = await deploySourceHead();

    const standard = await treasury.previewTrade(10_000n, 0);
    const unlinked = await treasury.previewTrade(10_000n, 1);
    const og = await treasury.previewTrade(10_000n, 2);
    const finalize = await treasury.previewFinalize(10_000n, 1);
    expect(standard.creator).to.equal(500n);
    expect(standard.recruiter).to.equal(1250n);
    expect(unlinked.creator).to.equal(500n);
    expect(unlinked.airdrop).to.equal(1500n);
    expect(og.creator).to.equal(500n);
    expect(og.recruiter).to.equal(1500n);
    expect(finalize.creator).to.equal(0n);

    await (
      await factory.connect(creator).createCampaign({
        name: "SourceHeadFork",
        symbol: "SHF",
        logoURI: "ipfs://source-head-fork",
        xAccount: "",
        website: "",
        extraLink: "",
        graduationTarget: VALID_BNB_TARGET_USD,
      })
    ).wait();
    const created = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", created.campaign, buyer);
    const token = await ethers.getContractAt("LaunchToken", created.token, buyer);
    expect(await campaign.strictFeeRouting()).to.equal(true);

    const nativeTarget = await campaign.graduationNativeTarget();
    expect(nativeTarget).to.be.gte(ethers.parseEther("0.009"));
    expect(nativeTarget).to.be.lte(ethers.parseEther("0.011"));

    const probe = ethers.parseEther("0.001");
    const beforePending = await creatorVault.pendingCreatorFees(created.campaign);
    await (await campaign.buyExactBnb(0n, { value: probe })).wait();
    const afterPending = await creatorVault.pendingCreatorFees(created.campaign);
    expect(afterPending).to.be.gt(beforePending);

    const remaining = nativeTarget - (await campaign.netRaisedWei()) + ethers.parseEther("0.001");
    await (await campaign.buyExactBnb(0n, { value: remaining })).wait();
    if (!(await campaign.launched())) await (await campaign.graduateIfEligible(0n, 0n)).wait();
    expect(await campaign.launched()).to.equal(true);

    const pendingCreatorFee = await creatorVault.pendingCreatorFees(created.campaign);
    expect(pendingCreatorFee).to.be.gt(0n);
    await (await creatorVault.connect(creator).claimCreatorFees(created.campaign)).wait();
    expect(await creatorVault.pendingCreatorFees(created.campaign)).to.equal(0n);

    const state = await campaign.getGraduationState();
    expect(state.dexPair).to.not.equal(ethers.ZeroAddress);
    expect(await topazFactory.getFee(state.dexPair, false)).to.equal(30n);
    const pool = new ethers.Contract(state.dexPair, POOL_ABI, ethers.provider);
    expect(await pool.stable()).to.equal(false);
    expect(await pool.factory()).to.equal(TOPAZ_FACTORY);

    const token0 = await pool.token0();
    const token1 = await pool.token1();
    const hasWbnb = token0.toLowerCase() === WBNB.toLowerCase() || token1.toLowerCase() === WBNB.toLowerCase();
    const hasToken = token0.toLowerCase() === created.token.toLowerCase() || token1.toLowerCase() === created.token.toLowerCase();
    expect(hasWbnb).to.equal(true);
    expect(hasToken).to.equal(true);

    const lockerAddress = await locker.getAddress();
    const lpBefore = await pool.balanceOf(lockerAddress);
    expect(lpBefore).to.equal(state.graduatedLiquidityLp);
    expect(lpBefore).to.be.gt(0n);
    expect(await locker.lockedBalance(state.dexPair)).to.equal(lpBefore);

    const router = new ethers.Contract(TOPAZ_ROUTER, EXEC_ROUTER_ABI, buyer);
    const buyRoute = [{ from: WBNB, dest: created.token, stable: false, factory: TOPAZ_FACTORY }];
    const sellRoute = [{ from: created.token, dest: WBNB, stable: false, factory: TOPAZ_FACTORY }];
    const deadline = (await latestTimestamp()) + 3600n;
    const buyIn = ethers.parseEther("0.02");
    const buyQuote = await router.getAmountsOut(buyIn, buyRoute);
    await (
      await router.swapExactETHForTokens((buyQuote.at(-1)! * 90n) / 100n, buyRoute, await buyer.getAddress(), deadline, {
        value: buyIn,
        gasLimit: 3_000_000n,
      })
    ).wait();

    const tokenContract = new ethers.Contract(created.token, ERC20_ABI, buyer);
    const sellAmount = BigInt(await tokenContract.balanceOf(await buyer.getAddress())) / 5n;
    expect(sellAmount).to.be.gt(0n);
    await (await tokenContract.approve(TOPAZ_ROUTER, ethers.MaxUint256)).wait();
    const sellQuote = await router.getAmountsOut(sellAmount, sellRoute);
    const minOut = (sellQuote.at(-1)! * 90n) / 100n;
    try {
      await (
        await router.swapExactTokensForETH(sellAmount, minOut, sellRoute, await buyer.getAddress(), deadline, { gasLimit: 3_000_000n })
      ).wait();
    } catch {
      await (
        await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
          sellAmount,
          minOut,
          sellRoute,
          await buyer.getAddress(),
          deadline,
          { gasLimit: 3_000_000n },
        )
      ).wait();
    }

    let claimable0 = 0n;
    let claimable1 = 0n;
    try {
      claimable0 = await pool.claimable0(lockerAddress);
      claimable1 = await pool.claimable1(lockerAddress);
    } catch {}
    if (claimable0 + claimable1 === 0n) {
      await (
        await router.swapExactETHForTokens(1n, buyRoute, await buyer.getAddress(), deadline + 100n, {
          value: ethers.parseEther("0.03"),
          gasLimit: 3_000_000n,
        })
      ).wait();
      try {
        claimable0 = await pool.claimable0(lockerAddress);
        claimable1 = await pool.claimable1(lockerAddress);
      } catch {}
    }

    const wbnb = new ethers.Contract(WBNB, ERC20_ABI, ethers.provider);
    const tokenIs0 = token0.toLowerCase() === created.token.toLowerCase();
    const claimedToken = tokenIs0 ? claimable0 : claimable1;
    const claimedWbnb = tokenIs0 ? claimable1 : claimable0;
    const protocolAddress = await protocol.getAddress();
    const creatorAddress = created.creator;
    const creatorTokenBefore = BigInt(await token.balanceOf(creatorAddress));
    const creatorWbnbBefore = BigInt(await wbnb.balanceOf(creatorAddress));
    const protocolTokenBefore = BigInt(await token.balanceOf(protocolAddress));
    const protocolWbnbBefore = BigInt(await wbnb.balanceOf(protocolAddress));

    await (await locker.harvest(state.dexPair, { gasLimit: 3_000_000n })).wait();
    expect(await pool.balanceOf(lockerAddress)).to.equal(lpBefore);
    expect(await locker.lockedBalance(state.dexPair)).to.equal(lpBefore);

    const creatorTokenDelta = BigInt(await token.balanceOf(creatorAddress)) - creatorTokenBefore;
    const creatorWbnbDelta = BigInt(await wbnb.balanceOf(creatorAddress)) - creatorWbnbBefore;
    const protocolTokenDelta = BigInt(await token.balanceOf(protocolAddress)) - protocolTokenBefore;
    const protocolWbnbDelta = BigInt(await wbnb.balanceOf(protocolAddress)) - protocolWbnbBefore;
    const harvestedTotal = creatorTokenDelta + creatorWbnbDelta + protocolTokenDelta + protocolWbnbDelta;
    expect(harvestedTotal).to.be.gt(0n);

    if (claimedToken > 0n) {
      expect(creatorTokenDelta).to.equal((claimedToken * CREATOR_SHARE_BPS) / BPS);
      expect(protocolTokenDelta).to.equal(claimedToken - creatorTokenDelta);
    } else if (creatorTokenDelta + protocolTokenDelta > 0n) {
      expect(creatorTokenDelta).to.equal(((creatorTokenDelta + protocolTokenDelta) * CREATOR_SHARE_BPS) / BPS);
    }
    if (claimedWbnb > 0n) {
      expect(creatorWbnbDelta).to.equal((claimedWbnb * CREATOR_SHARE_BPS) / BPS);
      expect(protocolWbnbDelta).to.equal(claimedWbnb - creatorWbnbDelta);
    } else if (creatorWbnbDelta + protocolWbnbDelta > 0n) {
      expect(creatorWbnbDelta).to.equal(((creatorWbnbDelta + protocolWbnbDelta) * CREATOR_SHARE_BPS) / BPS);
    }
  });
});
