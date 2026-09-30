import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { mineAt } from "./fixtures/evmgenCore";
import { deployCoreFixture } from "./fixtures/core";
import { quoteBuyExactTokens, quoteSellExactTokens, currentPrice as priceFn } from "./helpers/math";
import { getBalance } from "./helpers/balances";

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
  firstBuyTokens: 0n,
  firstBuyMaxCost: 0n,
  feeChoice: 1,
  feeCreatorPct: 0,
  lpReceiver: ethers.ZeroAddress,
  ...overrides,
});

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function makeGraduationEligibleByOracle(campaign: any, priceFeed: any) {
  const now = await latestTimestamp();
  await priceFeed.setRoundData(2n, ethers.parseUnits("1000", 8), now, now, 2n);
  expect(await campaign.netRaisedWei()).to.be.gte(await campaign.graduationNativeTarget());
}

// Every direct buy/sell below lands after the C2 anti-sniper window (5000 bps at launchAt falling to
// the flat 200 bps at +60 s), so the fee math is the flat protocolFeeBps the old tests assumed.
async function pastSniperWindow(campaign: any) {
  await mineAt(Number(await campaign.launchAt()) + 61);
}

async function createCampaignFixture() {
  const fx = await deployCoreFixture();
  const { factory, creator } = fx;

  await factory.connect(creator).createCampaign(baseCampaignRequest({ lpReceiver: await fx.lpReceiver.getAddress() }) as any);
  const info = await factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", await campaign.token());
  await pastSniperWindow(campaign);
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
    firstBuyTokens: 0n,
    firstBuyMaxCost: 0n,
    feeChoice: 1,
    feeCreatorPct: 0,
    liquidityBps: 8000,
  });
  await factory.connect(creator).createCampaign(baseCampaignRequest() as any);
  const info = await factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", await campaign.token());
  await pastSniperWindow(campaign);
  return { ...fx, info, campaign, token };
}

// Every destination a routed fee can reach. TreasuryRouterV3 splits the league
// share again into weekly and monthly, and pays a creator share that V1 had no
// concept of, so reading the weekly vault alone accounts for 30% of the league
// and none of the creator's -- which is what made these assertions look like
// lost money when the fee was routed correctly all along.
async function captureRouteBalances(vaults: any) {
  return {
    league:
      (await getBalance(await vaults.treasuryVault.getAddress())) +
      (await getBalance(await vaults.monthlyLeagueReceiver.getAddress())),
    creator: await getBalance(await vaults.creatorVault.getAddress()),
    recruiter: await getBalance(await vaults.recruiterVault.getAddress()),
    airdrop: await vaults.communityVault.warzoneAirdropBalance(),
    squad: await vaults.communityVault.squadPoolBalance(),
    protocol: await getBalance(await vaults.protocolVault.getAddress()),
  };
}

function addRouteAmounts(a: any, b: any) {
  return {
    league: a.league + b.league,
    creator: a.creator + b.creator,
    recruiter: a.recruiter + b.recruiter,
    airdrop: a.airdrop + b.airdrop,
    squad: a.squad + b.squad,
    protocol: a.protocol + b.protocol,
  };
}

async function expectRouteBalanceDelta(before: any, vaults: any, expected: any) {
  const after = await captureRouteBalances(vaults);
  expect(after.league - before.league).to.eq(expected.league);
  expect(after.creator - before.creator).to.eq(expected.creator);
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
    const { campaign, token, alice, treasuryRouter, treasuryVault, monthlyLeagueReceiver, creatorVault, recruiterVault, communityVault, protocolVault } = await loadFixture(createCampaignFixture);

    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();
    const feeBps = await campaign.protocolFeeBps();
    const amountOut = ethers.parseEther("10");
    const sold0 = await campaign.sold();
    const { costNoFee, fee, total } = quoteBuyExactTokens(BigInt(sold0), BigInt(amountOut), BigInt(base), BigInt(slope), BigInt(feeBps));

    const routeVaults = { treasuryVault, monthlyLeagueReceiver, creatorVault, recruiterVault, communityVault, protocolVault };
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
    const { campaign, token, alice, treasuryRouter, treasuryVault, monthlyLeagueReceiver, creatorVault, recruiterVault, communityVault, protocolVault } = await loadFixture(createCampaignFixture);

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

    const routeVaults = { treasuryVault, monthlyLeagueReceiver, creatorVault, recruiterVault, communityVault, protocolVault };
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

  // C5: the completion buy only marks Pending (no DEX, router-finalize or adapter call); anyone then
  // calls graduate(), which routes 2.2% to the protocol, credits 19.8% to the creator's pull balance
  // and sends 78% to the pool through the native graduation adapter (LP to the permanent locker).
  it("auto-finalize: completion buy triggers graduation; adds liquidity; burns unsold; transfers creatorReserve; pays creator; enables trading", async () => {
    const { campaign, token, factory, creator, alice, bob, graduationAdapter, permanentLpLocker, treasuryRouter, treasuryVault, monthlyLeagueReceiver, creatorVault, recruiterVault, communityVault, protocolVault } = await loadFixture(createLowTargetCampaignFixture);

    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);
    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();
    const feeBps = await campaign.protocolFeeBps();
    expect(await campaign.currentTradeFeeBps()).to.eq(feeBps);
    const { costNoFee, fee: tradeFee } = quoteBuyExactTokens(
      BigInt(await campaign.sold()),
      BigInt(curveSupply),
      BigInt(base),
      BigInt(slope),
      BigInt(feeBps)
    );
    expect(totalBuy).to.eq(costNoFee + tradeFee);
    const routeVaults = { treasuryVault, monthlyLeagueReceiver, creatorVault, recruiterVault, communityVault, protocolVault };
    const routeBefore = await captureRouteBalances(routeVaults);
    const tradeRoute = await treasuryRouter.previewRoute(tradeFee, 0, await campaign.tradeRouteProfile());
    const creatorAddr = await creator.getAddress();

    const buyTx = await campaign.connect(alice).buyExactTokens(curveSupply, totalBuy, { value: totalBuy });
    expect(await campaign.sold()).to.eq(curveSupply);
    const lastPrice = await campaign.currentPrice();
    // sold out: trigger 1, no oracle target
    await expect(buyTx).to.emit(campaign, "GraduationPending").withArgs(await alice.getAddress(), 1, costNoFee, 0n, lastPrice);
    await expect(buyTx).to.not.emit(campaign, "Graduated");
    expect(await campaign.graduationPending()).to.eq(true);
    expect(await campaign.launched()).to.eq(false);
    expect(await token.tradingEnabled()).to.eq(false);
    expect(await graduationAdapter.calls()).to.eq(0n);

    // exact C5 split of the frozen raise
    const R = costNoFee;
    const protocolShare = (R * 220n) / 10_000n;
    const creatorShare = (R * 1980n) / 10_000n;
    const poolNative = R - protocolShare - creatorShare;
    const memeTarget = (poolNative * 10n ** 18n) / lastPrice;
    const totalSupply = await campaign.totalSupply();
    const creatorReserve = await campaign.creatorReserve();
    const budget = totalSupply - creatorReserve - curveSupply;
    expect(budget).to.eq(await campaign.liquiditySupply());
    const burned = budget - memeTarget;

    const tx = await campaign.connect(bob).graduate();
    const state = await campaign.getGraduationState();
    await expect(tx)
      .to.emit(campaign, "Graduated")
      .withArgs(state.dexPair, R, protocolShare, creatorShare, poolNative, memeTarget, burned, lastPrice, lastPrice, false);
    await expect(tx).to.emit(factory, "CampaignGraduated").withArgs(await campaign.getAddress(), creatorAddr, state.dexPair, await permanentLpLocker.getAddress());
    expect(await campaign.launched()).to.eq(true);
    expect(await token.tradingEnabled()).to.eq(true);
    expect(await graduationAdapter.lastValue()).to.eq(poolNative);

    // trade fee + protocol graduation share, routed to the exact destinations
    const finalizeRoute = await treasuryRouter.previewRoute(protocolShare, 1, await campaign.finalizeRouteProfile());
    await expectRouteBalanceDelta(routeBefore, routeVaults, addRouteAmounts(tradeRoute, finalizeRoute));

    // the campaign keeps exactly the creator's pull balance; the creator pulls it
    expect(await campaign.pendingCreatorGraduation()).to.eq(creatorShare);
    expect(await getBalance(await campaign.getAddress())).to.eq(creatorShare);
    await expect(campaign.connect(creator).claimCreatorGraduation(creatorAddr, false)).to.changeEtherBalances(
      [campaign, creator],
      [-creatorShare, creatorShare]
    );
    expect(await getBalance(await campaign.getAddress())).to.eq(0n);

    expect(await token.balanceOf(creatorAddr)).to.eq(creatorReserve);
    expect(await token.balanceOf(await campaign.getAddress())).to.eq(0n);
    expect(await token.balanceOf(state.dexPair)).to.eq(memeTarget);

    expect(state.dexPair).to.not.eq(ethers.ZeroAddress);
    expect(state.finalCurvePrice).to.eq(lastPrice);
    expect(state.initialDexPrice).to.eq(lastPrice);
    expect(state.graduatedLiquidityTokens).to.eq(memeTarget);
    expect(state.graduatedLiquidityBnb).to.eq(poolNative);
    expect(state.burnedUnsoldTokens).to.eq(burned);
    expect(state.burnedUnusedLpTokens).to.eq(0n);
    expect(await token.totalSupply()).to.eq(totalSupply - burned);
    expect(state.postBurnTotalSupply).to.eq(await token.totalSupply());
  });

  it("permissionless graduation: rejects router liquidity that opens outside the curve price tolerance", async () => {
    const { campaign, alice, priceFeed, graduationAdapter } = await loadFixture(createCampaignFixture);

    const amount = ethers.parseUnits("20", 18);
    const quote = await campaign.quoteBuyExactTokens(amount);
    await campaign.connect(alice).buyExactTokens(amount, quote, { value: quote });
    expect(await campaign.graduationPending()).to.eq(false);
    await makeGraduationEligibleByOracle(campaign, priceFeed);

    // the pool opens 51 bps below the curve price (band is 50 bps): graduation reverts, nothing moves
    await graduationAdapter.setBehaviour(false, false, 0, 0, 0, 51, true);
    await expect(campaign.connect(alice).graduate()).to.be.revertedWithCustomError(campaign, "StartPriceOutOfBand");
    expect(await campaign.launched()).to.eq(false);
    expect(await campaign.graduationPending()).to.eq(false);

    // within the band it graduates, permissionlessly
    await graduationAdapter.setBehaviour(false, false, 0, 0, 0, 50, true);
    await expect(campaign.connect(alice).graduate()).to.emit(campaign, "Graduated");
    expect(await campaign.launched()).to.eq(true);
  });

  it("auto-finalize: reaching oracle USD threshold (without selling out) finalizes inside buy", async () => {
    const { campaign, token, alice, bob, graduationAdapter } = await loadFixture(createLowTargetCampaignFixture);

    const curveSupply = await campaign.curveSupply();
    const amountOut = ethers.parseEther("1");
    const totalBuy = await campaign.quoteBuyExactTokens(amountOut);
    const tx = await campaign.connect(alice).buyExactTokens(amountOut, totalBuy, { value: totalBuy });

    // USD target reached inside the buy: trigger 0, Pending in the same transaction, curve not sold out
    await expect(tx).to.emit(campaign, "GraduationPending");
    expect(await campaign.graduationPending()).to.eq(true);
    expect(await campaign.pendingTrigger()).to.eq(0);
    expect(await campaign.sold()).to.eq(amountOut);
    expect(await campaign.sold()).to.be.lt(curveSupply);
    expect(await graduationAdapter.calls()).to.eq(0n);

    await expect(campaign.connect(bob).graduate()).to.emit(campaign, "Graduated");
    expect(await campaign.launched()).to.eq(true);
    expect(await token.tradingEnabled()).to.eq(true);
    expect(await campaign.sold()).to.eq(amountOut);
  });

  it("price-driven graduation can be triggered permissionlessly after the oracle target falls", async () => {
    const { campaign, alice, priceFeed } = await loadFixture(createCampaignFixture);

    const amountOut = ethers.parseEther("10");
    const totalBuy = await campaign.quoteBuyExactTokens(amountOut);
    await campaign.connect(alice).buyExactTokens(amountOut, totalBuy, { value: totalBuy });
    expect(await campaign.launched()).to.eq(false);
    expect(await campaign.graduationPending()).to.eq(false);

    const target = await campaign.graduationTarget();
    const netRaised = await campaign.netRaisedWei();
    expect(netRaised).to.be.lt(await campaign.graduationNativeTarget());
    const bumpedPrice = (target * ethers.parseUnits("1", 8) + netRaised - 1n) / netRaised;
    const now = await latestTimestamp();
    await priceFeed.setRoundData(2n, bumpedPrice, now, now, 2n);
    expect(await campaign.graduationNativeTarget()).to.be.lte(netRaised);

    await expect(campaign.connect(alice).graduate())
      .to.emit(campaign, "GraduationPending")
      .and.to.emit(campaign, "Graduated");
    expect(await campaign.launched()).to.eq(true);
  });

  it("permissionless graduation rejects callers while oracle threshold is not met", async () => {
    const { campaign, alice } = await loadFixture(createCampaignFixture);

    await expect(campaign.connect(alice).graduate()).to.be.revertedWithCustomError(campaign, "GraduationNotDue");
    expect(await campaign.graduationPending()).to.eq(false);
  });

  it("auto-finalize: succeeds even if Topaz volatile pool is pre-created (empty)", async () => {
    const { campaign, token, alice, router, v2factory, permanentLpLocker } = await loadFixture(createLowTargetCampaignFixture);

    const Pool = await ethers.getContractFactory("MockTopazPool");
    const pool = await Pool.deploy();
    await pool.setTotalSupply(0);
    await pool.setReserves(0, 0);
    await v2factory.setPool(await token.getAddress(), await router.WETH(), false, await pool.getAddress());

    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);
    await expect(campaign.connect(alice).buyExactTokens(curveSupply, totalBuy, { value: totalBuy })).to.emit(campaign, "GraduationPending");
    await expect(campaign.connect(alice).graduate()).to.emit(campaign, "Graduated");

    expect(await token.tradingEnabled()).to.eq(true);
    const state = await campaign.getGraduationState();
    expect(state[0]).to.eq(await pool.getAddress());
    expect(await permanentLpLocker.registeredLpToken(await pool.getAddress())).to.eq(true);
  });

  it("post-finalize: trading restriction lifted; buys/sells revert", async () => {
    const { campaign, token, alice, bob } = await loadFixture(createLowTargetCampaignFixture);

    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);
    await campaign.connect(alice).buyExactTokens(curveSupply, totalBuy, { value: totalBuy });

    // Pending: the curve is frozen and the token is not yet transferable
    await expect(campaign.connect(alice).buyExactTokens(1n, 0n, { value: 0n })).to.be.revertedWithCustomError(campaign, "GraduationIsPending");
    await expect(campaign.connect(alice).sellExactTokens(1n, 0n)).to.be.revertedWithCustomError(campaign, "GraduationIsPending");
    await expect(token.connect(alice).transfer(await bob.getAddress(), 1n)).to.be.reverted;

    await campaign.connect(bob).graduate();

    await expect(campaign.connect(alice).buyExactTokens(1n, 0n, { value: 0n })).to.be.revertedWithCustomError(campaign, "Finalized");
    await expect(campaign.connect(alice).sellExactTokens(1n, 0n)).to.be.revertedWithCustomError(campaign, "Finalized");
    await expect(campaign.connect(alice).graduate()).to.be.revertedWithCustomError(campaign, "Finalized");

    await token.connect(alice).transfer(await bob.getAddress(), ethers.parseEther("1"));
    expect(await token.balanceOf(await bob.getAddress())).to.eq(ethers.parseEther("1"));
  });
});
