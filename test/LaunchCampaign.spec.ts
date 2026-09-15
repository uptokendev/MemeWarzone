import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { completeNativeGraduation, deployCoreFixture } from "./fixtures/core";
import { quoteBuyExactTokens, quoteSellExactTokens, currentPrice as priceFn } from "./helpers/math";
import { getBalance } from "./helpers/balances";

const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const baseCampaignRequest = (overrides: Record<string, unknown> = {}) => ({
  name: "MyToken",
  symbol: "MYT",
  logoURI: "ipfs://logo",
  xAccount: "x",
  website: "w",
  extraLink: "e",
  basePrice: 0n,
  priceSlope: 0n,
  graduationTarget: 0n,
  lpReceiver: ethers.ZeroAddress,
  ...overrides,
});

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
  return { priceFeed, graduationOracle };
}

async function makeGraduationEligibleByOracle(campaign: any, priceFeed: any) {
  const now = await latestTimestamp();
  await priceFeed.setRoundData(2n, ethers.parseUnits("1000", 8), now, now, 2n);
  expect(await campaign.netRaisedWei()).to.be.gte(await campaign.graduationNativeTarget());
}

const directInitParams = async (values: {
  creator: string;
  owner: string;
  router: string;
  graduationOracle?: string;
  feeRecipient?: string;
  leagueReceiver?: string;
  lpReceiver?: string;
  name?: string;
  symbol?: string;
  graduationTarget?: bigint;
  protocolFeeBps?: bigint | number;
  leagueFeeBps?: bigint | number;
  basePrice?: bigint;
  priceSlope?: bigint;
}) => ({
  name: values.name ?? "T",
  symbol: values.symbol ?? "T",
  logoURI: "ipfs://logo",
  totalSupply: ethers.parseEther("1000"),
  curveBps: 5000,
  liquidityTokenBps: 4000,
  basePrice: values.basePrice ?? 10n ** 12n,
  priceSlope: values.priceSlope ?? 10n ** 9n,
  graduationTarget: values.graduationTarget ?? ethers.parseEther("1"),
  graduationOracle: values.graduationOracle ?? await (await deployTestOracle()).graduationOracle.getAddress(),
  liquidityBps: 8000,
  protocolFeeBps: values.protocolFeeBps ?? 200,
  leagueFeeBps: values.leagueFeeBps ?? 75,
  leagueReceiver: values.leagueReceiver ?? values.owner,
  router: values.router,
  lpReceiver: values.lpReceiver ?? values.creator,
  feeRecipient: values.feeRecipient ?? values.owner,
  creator: values.creator,
  factory: values.creator,
  riskRegistry: ethers.ZeroAddress,
  creatorBuyLockUntil: 0n,
  creatorBuyCapWei: 0n,
  requireAuthorizedTrading: false,
  tradeRouteProfile: 1,
  finalizeRouteProfile: 1,
});

async function createCampaignFixture() {
  const fx = await deployCoreFixture();
  const { factory, creator } = fx;

  await factory.connect(creator).createCampaign(baseCampaignRequest({ lpReceiver: await fx.lpReceiver.getAddress() }) as any);
  const info = await factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", await campaign.token());
  return { ...fx, info, campaign, token };
}

async function createLowTargetCampaignFixture() {
  const fx = await deployCoreFixture();
  const { factory, owner, creator } = fx;

  await factory.connect(owner).setConfig({
    totalSupply: ethers.parseEther("1000"),
    curveBps: 5000,
    liquidityTokenBps: 4000,
    basePrice: 10n ** 12n,
    priceSlope: 10n ** 9n,
    graduationTarget: 1n,
    liquidityBps: 8000,
  });
  await factory.connect(creator).createCampaign(baseCampaignRequest() as any);
  const info = await factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", await campaign.token());
  return { ...fx, info, campaign, token };
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

  const [, creator] = await ethers.getSigners();
  const txClone = await creator.sendTransaction({ data: minimalProxyBytecode });
  const receipt = await txClone.wait();
  const cloneAddr = receipt!.contractAddress;
  const campaign = Campaign.attach(cloneAddr);
  await campaign.initialize(params);
  return campaign;
}

async function captureRouteBalances(vaults: any) {
  return {
    league: await getBalance(await vaults.treasuryVault.getAddress()),
    recruiter: await getBalance(await vaults.recruiterVault.getAddress()),
    airdrop: await vaults.communityVault.warzoneAirdropBalance(),
    squad: await vaults.communityVault.squadPoolBalance(),
    protocol: await getBalance(await vaults.protocolVault.getAddress()),
  };
}

function addRouteAmounts(a: any, b: any) {
  return {
    league: a.league + b.league,
    recruiter: a.recruiter + b.recruiter,
    airdrop: a.airdrop + b.airdrop,
    squad: a.squad + b.squad,
    protocol: a.protocol + b.protocol,
  };
}

async function expectRouteBalanceDelta(before: any, vaults: any, expected: any) {
  const after = await captureRouteBalances(vaults);
  expect(after.league - before.league).to.eq(expected.league);
  expect(after.recruiter - before.recruiter).to.eq(expected.recruiter);
  expect(after.airdrop - before.airdrop).to.eq(expected.airdrop);
  expect(after.squad - before.squad).to.eq(expected.squad);
  expect(after.protocol - before.protocol).to.eq(expected.protocol);
}

describe("LaunchCampaign", function () {
  it("initial state / immutables / token minted to campaign", async () => {
    const { campaign, token, graduationOracle } = await loadFixture(createCampaignFixture);

    expect(await campaign.launched()).to.eq(false);
    expect(await token.owner()).to.eq(await campaign.getAddress());
    expect(await campaign.graduationOracle()).to.eq(await graduationOracle.getAddress());
    expect(await campaign.graduationNativeTarget()).to.eq(await campaign.graduationTarget());

    const totalSupply = await campaign.totalSupply();
    expect(await token.balanceOf(await campaign.getAddress())).to.eq(totalSupply);
    expect(await token.tradingEnabled()).to.eq(false);
  });

  it("quoteBuyExactTokens / quoteSellExactTokens guard rails", async () => {
    const { campaign } = await loadFixture(createCampaignFixture);

    await expect(campaign.quoteBuyExactTokens(0n)).to.be.revertedWithCustomError(campaign, "ZeroAmount");
    await expect(campaign.quoteSellExactTokens(0n)).to.be.revertedWithCustomError(campaign, "ZeroAmount");
    await expect(campaign.quoteSellExactTokens(1n)).to.be.revertedWithCustomError(campaign, "ExceedsSold");

    const curveSupply = await campaign.curveSupply();
    await expect(campaign.quoteBuyExactTokens(curveSupply + 1n)).to.be.revertedWithCustomError(campaign, "SoldOut");
  });

  it("currentPrice matches formula", async () => {
    const { campaign } = await loadFixture(createCampaignFixture);
    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();

    expect(await campaign.currentPrice()).to.eq(priceFn(base, slope, 0n));
  });

  it("buyExactTokens: transfers tokens, updates sold & counters, emits, sends fee, refunds overpay", async () => {
    const { campaign, token, alice, treasuryRouter, treasuryVault, recruiterVault, communityVault, protocolVault } = await loadFixture(createCampaignFixture);

    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();
    const feeBps = await campaign.protocolFeeBps();
    const amountOut = ethers.parseEther("10");
    const sold0 = await campaign.sold();
    const { costNoFee, fee, total } = quoteBuyExactTokens(BigInt(sold0), BigInt(amountOut), BigInt(base), BigInt(slope), BigInt(feeBps));

    const routeVaults = { treasuryVault, recruiterVault, communityVault, protocolVault };
    const routeBefore = await captureRouteBalances(routeVaults);
    const expectedRoute = await treasuryRouter.previewRoute(fee, 0, await campaign.tradeRouteProfile());
    const buyerBefore = await getBalance(await alice.getAddress());
    const campBefore = await getBalance(await campaign.getAddress());

    const tx = await campaign.connect(alice).buyExactTokens(amountOut, total, { value: total + ethers.parseEther("1") });
    await expect(tx).to.emit(campaign, "TokensPurchased").withArgs(await alice.getAddress(), amountOut, total);

    expect(await token.balanceOf(await alice.getAddress())).to.eq(amountOut);
    expect(await campaign.sold()).to.eq(sold0 + amountOut);
    expect(await campaign.totalBuyVolumeWei()).to.eq(costNoFee);
    expect(await campaign.buyersCount()).to.eq(1n);
    expect(await campaign.hasBought(await alice.getAddress())).to.eq(true);

    await expectRouteBalanceDelta(routeBefore, routeVaults, expectedRoute);

    const campAfter = await getBalance(await campaign.getAddress());
    expect(campAfter - campBefore).to.eq(costNoFee);

    const buyerAfter = await getBalance(await alice.getAddress());
    expect(buyerBefore - buyerAfter).to.be.gte(total);
  });

  it("buyExactTokens: slippage & value checks", async () => {
    const { campaign, alice } = await loadFixture(createCampaignFixture);

    const amountOut = ethers.parseEther("1");
    const total = await campaign.quoteBuyExactTokens(amountOut);

    await expect(campaign.connect(alice).buyExactTokens(amountOut, total - 1n, { value: total })).to.be.revertedWithCustomError(campaign, "Slippage");
    await expect(campaign.connect(alice).buyExactTokens(amountOut, total, { value: total - 1n })).to.be.revertedWithCustomError(campaign, "InsufficientValue");
  });

  it("sellExactTokens: transfers tokens back, pays out, updates sold & counters, emits, takes fee", async () => {
    const { campaign, token, alice, treasuryRouter, treasuryVault, recruiterVault, communityVault, protocolVault } = await loadFixture(createCampaignFixture);

    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();
    const feeBps = await campaign.protocolFeeBps();

    const amountOut = ethers.parseEther("10");
    const totalBuy = await campaign.quoteBuyExactTokens(amountOut);
    await campaign.connect(alice).buyExactTokens(amountOut, totalBuy, { value: totalBuy });

    const amountIn = ethers.parseEther("4");
    await token.connect(alice).approve(await campaign.getAddress(), amountIn);

    const soldBefore = await campaign.sold();
    const { gross, fee, payout } = quoteSellExactTokens(BigInt(soldBefore), BigInt(amountIn), BigInt(base), BigInt(slope), BigInt(feeBps));

    const routeVaults = { treasuryVault, recruiterVault, communityVault, protocolVault };
    const routeBefore = await captureRouteBalances(routeVaults);
    const expectedRoute = await treasuryRouter.previewRoute(fee, 0, await campaign.tradeRouteProfile());
    const campBefore = await getBalance(await campaign.getAddress());

    const tx = await campaign.connect(alice).sellExactTokens(amountIn, payout);
    await expect(tx).to.emit(campaign, "TokensSold").withArgs(await alice.getAddress(), amountIn, payout);

    expect(await campaign.sold()).to.eq(soldBefore - amountIn);
    expect(await token.balanceOf(await alice.getAddress())).to.eq(amountOut - amountIn);

    await expectRouteBalanceDelta(routeBefore, routeVaults, expectedRoute);

    const campAfter = await getBalance(await campaign.getAddress());
    expect(campBefore - campAfter).to.eq(gross);
    expect(await campaign.totalSellVolumeWei()).to.eq(gross);
  });

  it("sellExactTokens: slippage protection", async () => {
    const { campaign, token, alice } = await loadFixture(createCampaignFixture);

    const amountOut = ethers.parseEther("5");
    const totalBuy = await campaign.quoteBuyExactTokens(amountOut);
    await campaign.connect(alice).buyExactTokens(amountOut, totalBuy, { value: totalBuy });

    const amountIn = ethers.parseEther("1");
    await token.connect(alice).approve(await campaign.getAddress(), amountIn);

    const minPayout = (await campaign.quoteSellExactTokens(amountIn)) + 1n;
    await expect(campaign.connect(alice).sellExactTokens(amountIn, minPayout)).to.be.revertedWithCustomError(campaign, "Slippage");
  });

  it("buyExactTokens enforces curveSupply cap (no oversell)", async () => {
    const { campaign, alice } = await loadFixture(createCampaignFixture);

    const curveSupply = await campaign.curveSupply();
    const maxCost = (await campaign.quoteBuyExactTokens(curveSupply)) + ethers.parseEther("100");
    await expect(campaign.connect(alice).buyExactTokens(curveSupply + 1n, maxCost, { value: maxCost })).to.be.revertedWithCustomError(campaign, "SoldOut");
  });

  it("buyExactTokens / sellExactTokens reject zero amounts (consistent with quote)", async () => {
    const { campaign, alice } = await loadFixture(createCampaignFixture);

    await expect(campaign.connect(alice).buyExactTokens(0n, 0n, { value: 0n })).to.be.revertedWithCustomError(campaign, "ZeroAmount");
    await expect(campaign.connect(alice).sellExactTokens(0n, 0n)).to.be.revertedWithCustomError(campaign, "ZeroAmount");
  });

  it("fee receivers cannot DOS: feeRecipient revert escrows; leagueReceiver router forward failure doesn't revert", async () => {
    const { creator, owner, alice } = await deployCoreFixture();

    const Reverting = await ethers.getContractFactory("RevertingReceiver");
    const feeRecipient = await Reverting.deploy();
    await feeRecipient.waitForDeployment();

    const vault = await Reverting.deploy();
    await vault.waitForDeployment();

    const TreasuryRouter = await ethers.getContractFactory("TreasuryRouter");
    const leagueReceiver = await TreasuryRouter.deploy(await owner.getAddress(), await vault.getAddress(), 3600);
    await leagueReceiver.waitForDeployment();

    const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
    const topazFactory = await TopazFactory.deploy();
    await topazFactory.waitForDeployment();

    const Router = await ethers.getContractFactory("MockRouter");
    const dexRouter = await Router.deploy(await topazFactory.getAddress(), await owner.getAddress());
    await dexRouter.waitForDeployment();

    const campaign = await deployDirectCampaign(
      await directInitParams({
        creator: await creator.getAddress(),
        owner: await owner.getAddress(),
        router: await dexRouter.getAddress(),
        feeRecipient: await feeRecipient.getAddress(),
        leagueReceiver: await leagueReceiver.getAddress(),
      })
    );
    const token = await ethers.getContractAt("LaunchToken", await campaign.token());

    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();
    const feeBps = await campaign.protocolFeeBps();
    const amountOut = ethers.parseEther("10");
    const sold0 = await campaign.sold();
    const { costNoFee, fee, total } = quoteBuyExactTokens(BigInt(sold0), BigInt(amountOut), BigInt(base), BigInt(slope), BigInt(feeBps));

    const leagueFeeBps = BigInt(await campaign.leagueFeeBps());
    const leagueFee = (costNoFee * leagueFeeBps) / 10_000n;
    const protocolNet = fee - leagueFee;

    const tx = await campaign.connect(alice).buyExactTokens(amountOut, total, { value: total });

    expect(await token.balanceOf(await alice.getAddress())).to.eq(amountOut);
    await expect(tx).to.emit(campaign, "NativeEscrowed").withArgs(await feeRecipient.getAddress(), protocolNet);
    expect(await campaign.pendingNative(await feeRecipient.getAddress())).to.eq(protocolNet);
    expect(await campaign.pendingNativeTotal()).to.eq(protocolNet);
    await expect(tx).to.emit(leagueReceiver, "ForwardFailed").withArgs(await vault.getAddress(), leagueFee);
    expect(await ethers.provider.getBalance(await leagueReceiver.getAddress())).to.eq(leagueFee);
  });

  it("pending escrow does not count toward graduation threshold", async () => {
    const { creator, owner, alice } = await deployCoreFixture();

    const Reverting = await ethers.getContractFactory("RevertingReceiver");
    const feeRecipient = await Reverting.deploy();
    await feeRecipient.waitForDeployment();

    const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
    const topazFactory = await TopazFactory.deploy();
    await topazFactory.waitForDeployment();

    const Router = await ethers.getContractFactory("MockRouter");
    const dexRouter = await Router.deploy(await topazFactory.getAddress(), await owner.getAddress());
    await dexRouter.waitForDeployment();

    const amountOut = ethers.parseEther("1");
    const basePrice = 10n ** 12n;
    const priceSlope = 10n ** 9n;
    const protocolFeeBps = 200n;
    const { total } = quoteBuyExactTokens(0n, amountOut, basePrice, priceSlope, protocolFeeBps);

    const campaign = await deployDirectCampaign(
      await directInitParams({
        creator: await creator.getAddress(),
        owner: await owner.getAddress(),
        router: await dexRouter.getAddress(),
        feeRecipient: await feeRecipient.getAddress(),
        name: "Escrowed",
        symbol: "ESC",
        graduationTarget: total,
        leagueFeeBps: 0,
        basePrice,
        priceSlope,
        protocolFeeBps,
      })
    );

    await campaign.connect(alice).buyExactTokens(amountOut, total, { value: total });

    expect(await campaign.launched()).to.eq(false);
    expect(await campaign.pendingNativeTotal()).to.be.gt(0n);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.eq(total);
  });

  it("auto-finalize: completion buy triggers graduation; adds liquidity; burns unsold; transfers creatorReserve; pays creator; enables trading", async () => {
    const { campaign, token, creator, alice, router, treasuryRouter, treasuryVault, recruiterVault, communityVault, protocolVault } = await loadFixture(createLowTargetCampaignFixture);

    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);
    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();
    const feeBps = await campaign.protocolFeeBps();
    const { fee: tradeFee } = quoteBuyExactTokens(
      BigInt(await campaign.sold()),
      BigInt(curveSupply),
      BigInt(base),
      BigInt(slope),
      BigInt(feeBps)
    );
    const routeVaults = { treasuryVault, recruiterVault, communityVault, protocolVault };
    const routeBefore = await captureRouteBalances(routeVaults);
    const tradeRoute = await treasuryRouter.previewRoute(tradeFee, 0, await campaign.tradeRouteProfile());
    const ownerAddr = await creator.getAddress();
    const creatorBalBefore = await getBalance(ownerAddr);

    const tx = await campaign.connect(alice).buyExactTokens(curveSupply, totalBuy, { value: totalBuy });
    expect(await campaign.graduationPending()).to.eq(true);
    expect(await campaign.launched()).to.eq(false);
    const completeTx = await completeNativeGraduation(campaign, alice);
    const receipt = await completeTx!.wait();

    expect(await campaign.sold()).to.eq(curveSupply);
    await expect(completeTx).to.emit(campaign, "CampaignFinalized");
    await expect(completeTx).to.emit(router, "LiquidityAdded");
    await expect(completeTx).to.emit(router, "LiquidityAdded").withArgs(await token.getAddress(), anyValue, anyValue, "0x000000000000000000000000000000000000dEaD");
    expect(await campaign.launched()).to.eq(true);
    expect(await token.tradingEnabled()).to.eq(true);
    expect(await getBalance(await campaign.getAddress())).to.eq(0n);

    const ev = receipt!.logs
      .map((l: any) => {
        try {
          return campaign.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p && p.name === "CampaignFinalized");

    expect(ev).to.not.eq(undefined);
    const protocolFee = BigInt(ev!.args.protocolFee.toString());
    const finalizeRoute = await treasuryRouter.previewRoute(protocolFee, 1, await campaign.finalizeRouteProfile());
    await expectRouteBalanceDelta(routeBefore, routeVaults, addRouteAmounts(tradeRoute, finalizeRoute));
    const creatorBalAfter = await getBalance(ownerAddr);
    expect(creatorBalAfter).to.be.gt(creatorBalBefore);

    const creatorReserve = await campaign.creatorReserve();
    expect(await token.balanceOf(ownerAddr)).to.be.gte(creatorReserve);

    const state = await campaign.getGraduationState();
    expect(state[0]).to.not.eq(ethers.ZeroAddress);
    expect(state[1]).to.eq(await campaign.currentPrice());
    expect(state[2]).to.eq(state[1]);
    expect(ev!.args.finalCurvePrice).to.eq(state[1]);
    expect(ev!.args.initialDexPrice).to.eq(state[2]);

    const totalSupply = await campaign.totalSupply();
    const soldAtFinalize = await campaign.sold();
    const expectedUnsoldBurn = curveSupply - soldAtFinalize;
    const expectedUnusedLpBurn = state[7];
    expect(state[6]).to.eq(expectedUnsoldBurn);
    expect(expectedUnusedLpBurn).to.be.gt(0n);
    expect(await token.totalSupply()).to.eq(totalSupply - expectedUnsoldBurn - expectedUnusedLpBurn);
    expect(state[8]).to.eq(await token.totalSupply());
  });

  it("permissionless graduation: rejects router liquidity that opens outside the curve price tolerance", async () => {
    const { owner, creator, alice } = await deployCoreFixture();

    const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
    const topazFactory = await TopazFactory.deploy();
    await topazFactory.waitForDeployment();

    const DriftRouter = await ethers.getContractFactory("MockDriftRouter");
    const driftRouter = await DriftRouter.deploy(await topazFactory.getAddress(), await owner.getAddress());
    await driftRouter.waitForDeployment();

    const { priceFeed, graduationOracle } = await deployTestOracle();
    const campaign = await deployDirectCampaign(
      await directInitParams({
        creator: await creator.getAddress(),
        owner: await owner.getAddress(),
        router: await driftRouter.getAddress(),
        graduationOracle: await graduationOracle.getAddress(),
        feeRecipient: await owner.getAddress(),
        leagueReceiver: await owner.getAddress(),
        basePrice: ethers.parseEther("0.005"),
        priceSlope: 10n ** 9n,
        graduationTarget: ethers.parseEther("2"),
      })
    );

    const oneToken = ethers.parseUnits("1", 18);
    const quote = await campaign.quoteBuyExactTokens(oneToken);
    await campaign.connect(alice).buyExactTokens(oneToken, quote, { value: quote });
    await makeGraduationEligibleByOracle(campaign, priceFeed);

    await expect(campaign.connect(alice).graduateIfEligible(0, 0)).to.emit(campaign, "StockGraduationPending");
    expect(await campaign.graduationPending()).to.eq(true);
    await expect(campaign.connect(alice).graduateIfEligible(0, 0)).to.be.revertedWithCustomError(campaign, "DexPriceDrift");
    expect(await campaign.graduationPending()).to.eq(true);
    expect(await campaign.launched()).to.eq(false);
  });

  it("auto-finalize: reaching oracle USD threshold (without selling out) marks pending then finalizes separately", async () => {
    const { campaign, token, alice, router } = await loadFixture(createLowTargetCampaignFixture);

    const curveSupply = await campaign.curveSupply();
    let amountOut = ethers.parseEther("1");
    while (amountOut * 2n < curveSupply) {
      const totalBuy = await campaign.quoteBuyExactTokens(amountOut);
      const txTry = await campaign.connect(alice).buyExactTokens(amountOut, totalBuy, { value: totalBuy });
      if (await campaign.graduationPending()) {
        await expect(txTry).to.emit(campaign, "StockGraduationPending");
        await expect(txTry).to.not.emit(campaign, "CampaignFinalized");
        expect(await campaign.launched()).to.eq(false);
        const completeTx = await completeNativeGraduation(campaign, alice);
        await expect(completeTx).to.emit(campaign, "CampaignFinalized");
        await expect(completeTx).to.emit(router, "LiquidityAdded");
        expect(await token.tradingEnabled()).to.eq(true);
        expect(await campaign.sold()).to.eq(amountOut);
        expect(await campaign.sold()).to.be.lt(curveSupply);
        return;
      }
      await token.connect(alice).approve(await campaign.getAddress(), amountOut);
      await campaign.connect(alice).sellExactTokens(amountOut, 0n);
      amountOut = amountOut * 2n;
    }

    throw new Error("Failed to trigger oracle graduation threshold without selling out curve");
  });

  it("price-driven graduation can be triggered permissionlessly after the oracle target falls", async () => {
    const { factory, creator, alice, priceFeed } = await deployCoreFixture();

    await factory.connect(creator).createCampaign(baseCampaignRequest({ graduationTarget: ethers.parseEther("100") }) as any);
    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);

    const amountOut = ethers.parseEther("10");
    const totalBuy = await campaign.quoteBuyExactTokens(amountOut);
    await campaign.connect(alice).buyExactTokens(amountOut, totalBuy, { value: totalBuy });
    expect(await campaign.launched()).to.eq(false);

    const netRaised = await campaign.netRaisedWei();
    const bumpedPrice = (ethers.parseEther("100") * ethers.parseUnits("1", 8) + netRaised - 1n) / netRaised;
    const now = await latestTimestamp();
    await priceFeed.setRoundData(2n, bumpedPrice, now, now, 2n);

    await expect(campaign.connect(alice).graduateIfEligible(0, 0)).to.emit(campaign, "StockGraduationPending");
    expect(await campaign.graduationPending()).to.eq(true);
    await expect(campaign.connect(alice).graduateIfEligible(0, 0)).to.emit(campaign, "CampaignFinalized");
    expect(await campaign.launched()).to.eq(true);
  });

  it("permissionless graduation rejects callers while oracle threshold is not met", async () => {
    const { campaign, alice } = await loadFixture(createCampaignFixture);

    await expect(campaign.connect(alice).graduateIfEligible(0, 0)).to.be.revertedWithCustomError(campaign, "ThresholdNotMet");
  });

  it("auto-finalize: succeeds even if Topaz volatile pool is pre-created (empty)", async () => {
    const { campaign, token, alice, router, v2factory } = await loadFixture(createLowTargetCampaignFixture);

    const Pool = await ethers.getContractFactory("MockTopazPool");
    const pool = await Pool.deploy();
    await pool.setTotalSupply(0);
    await pool.setReserves(0, 0);
    await v2factory.setPool(await token.getAddress(), await router.WETH(), false, await pool.getAddress());

    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);
    await campaign.connect(alice).buyExactTokens(curveSupply, totalBuy, { value: totalBuy });
    expect(await campaign.graduationPending()).to.eq(true);
    const tx = await completeNativeGraduation(campaign, alice);

    await expect(tx).to.emit(campaign, "CampaignFinalized");
    await expect(tx).to.emit(router, "LiquidityAdded");
    expect(await token.tradingEnabled()).to.eq(true);
    const state = await campaign.getGraduationState();
    expect(state[0]).to.eq(await pool.getAddress());
  });

  it("post-finalize: trading restriction lifted; buys/sells revert", async () => {
    const { campaign, token, alice, bob } = await loadFixture(createLowTargetCampaignFixture);

    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);
    await campaign.connect(alice).buyExactTokens(curveSupply, totalBuy, { value: totalBuy });
    await completeNativeGraduation(campaign, alice);

    await expect(campaign.connect(alice).buyExactTokens(1n, 0n, { value: 0n })).to.be.revertedWithCustomError(campaign, "Finalized");
    await expect(campaign.connect(alice).sellExactTokens(1n, 0n)).to.be.revertedWithCustomError(campaign, "Finalized");

    await token.connect(alice).transfer(await bob.getAddress(), ethers.parseEther("1"));
    expect(await token.balanceOf(await bob.getAddress())).to.eq(ethers.parseEther("1"));
  });
});
