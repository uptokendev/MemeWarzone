import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployCoreFixture } from "./fixtures/core";

const baseCampaignRequest = (overrides: Record<string, unknown> = {}) => ({
  name: "CloseoutToken",
  symbol: "CLOSE",
  logoURI: "ipfs://closeout-logo",
  xAccount: "",
  website: "",
  extraLink: "",
  graduationTarget: 0n,
  firstBuyTokens: 0n,
  firstBuyMaxCost: 0n,
  feeChoice: 1,
  feeCreatorPct: 0,
  ...overrides,
});

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function makeGraduationEligibleByOracle(campaign: any, priceFeed: any) {
  const now = await latestTimestamp();
  await priceFeed.setRoundData(2n, ethers.parseUnits("1000000", 8), now, now, 2n);
  expect(await campaign.netRaisedWei()).to.be.gte(await campaign.graduationNativeTarget());
}

async function createCampaignWith(overrides: Record<string, unknown> = {}) {
  const fx = await deployCoreFixture();
  await fx.factory.connect(fx.creator).createCampaign(baseCampaignRequest(overrides) as any);
  const info = await fx.factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);
  return { ...fx, info, campaign, token };
}

async function createCampaignFixture() {
  return createCampaignWith();
}

// EVM launch generation: the fixture's default target ($1 at a $1 oracle = 1 native, inside the 95%-of-curve
// range) is not reached by the small buys below. The old $100k target is refused (TargetOutOfRangeAtPrice).
// Time is moved past the 60 s anti-sniper window (C2) so the flat 2% fee applies and a quote taken in one block
// executes identically in the next.
async function createHighTargetCampaignFixture() {
  const fx = await createCampaignWith();
  await time.increase(61);
  return fx;
}

// A $1e-18 target: any buy crosses it. Uses the fixture curve (the old 1e9 slope breaks the C5 supply bound).
async function createLowTargetCampaignFixture() {
  const fx = await createCampaignWith({ graduationTarget: 1n });
  await time.increase(61);
  return fx;
}

describe("LaunchCampaign closeout integration", function () {
  it("quoteBuyExactBnb returns zeros for zero input", async () => {
    const { campaign } = await loadFixture(createCampaignFixture);

    const quote = await campaign.quoteBuyExactBnb(0n);
    expect(quote.tokensOut).to.eq(0n);
    expect(quote.totalCostWei).to.eq(0n);
    expect(quote.feeWei).to.eq(0n);
  });

  it("buyExactBnb spends the quoted amount, refunds dust, and updates buyer counters", async () => {
    const { campaign, token, alice } = await loadFixture(createHighTargetCampaignFixture);
    const value = ethers.parseEther("0.01");
    const quote = await campaign.quoteBuyExactBnb(value);

    expect(quote.tokensOut).to.be.gt(0n);
    expect(quote.totalCostWei).to.be.gt(0n);
    expect(quote.totalCostWei).to.be.lte(value);

    await expect(campaign.connect(alice).buyExactBnb(quote.tokensOut, { value }))
      .to.emit(campaign, "TokensPurchased")
      .withArgs(await alice.getAddress(), quote.tokensOut, quote.totalCostWei);

    expect(await token.balanceOf(await alice.getAddress())).to.eq(quote.tokensOut);
    expect(await campaign.sold()).to.eq(quote.tokensOut);
    expect(await campaign.totalBuyVolumeWei()).to.eq(quote.totalCostWei - quote.feeWei);
    expect(await campaign.buyersCount()).to.eq(1n);
    expect(await campaign.hasBought(await alice.getAddress())).to.eq(true);
    expect(await campaign.launched()).to.eq(false);
  });

  it("buyExactBnb enforces minimum token output and non-zero executable buys", async () => {
    const { campaign, alice } = await loadFixture(createHighTargetCampaignFixture);
    const value = ethers.parseEther("0.005");
    const quote = await campaign.quoteBuyExactBnb(value);

    await expect(campaign.connect(alice).buyExactBnb(quote.tokensOut + 1n, { value })).to.be.revertedWithCustomError(campaign, "Slippage");
    await expect(campaign.connect(alice).buyExactBnb(0n, { value: 0n })).to.be.revertedWithCustomError(campaign, "ZeroAmount");
  });

  it("factory pause controls are owner-only and campaign pause blocks buys", async () => {
    const { factory, campaign, owner, alice } = await loadFixture(createHighTargetCampaignFixture);
    const amountOut = ethers.parseEther("1");
    const total = await campaign.quoteBuyExactTokens(amountOut);

    await expect(campaign.connect(owner).setPauseState(true, false, false, false)).to.be.revertedWithCustomError(
      campaign,
      "OnlyFactory"
    );
    await expect(factory.connect(alice).setCampaignPauses(await campaign.getAddress(), true, false, false, false)).to.be.revertedWithCustomError(
      factory,
      "OwnableUnauthorizedAccount"
    );

    await expect(factory.connect(owner).setCampaignPauses(await campaign.getAddress(), true, false, false, false))
      .to.emit(factory, "CampaignPauseUpdated")
      .withArgs(await campaign.getAddress(), true, false, false, false);

    await expect(campaign.connect(alice).buyExactTokens(amountOut, total, { value: total })).to.be.revertedWithCustomError(
      campaign,
      "CampaignPaused"
    );
  });

  it("buy and sell pause controls gate only their respective trade directions", async () => {
    const { factory, campaign, token, owner, alice } = await loadFixture(createHighTargetCampaignFixture);
    const amountOut = ethers.parseEther("2");
    const total = await campaign.quoteBuyExactTokens(amountOut);

    await factory.connect(owner).setCampaignPauses(await campaign.getAddress(), false, true, false, false);
    await expect(campaign.connect(alice).buyExactTokens(amountOut, total, { value: total })).to.be.revertedWithCustomError(
      campaign,
      "BuysPaused"
    );

    await factory.connect(owner).setCampaignPauses(await campaign.getAddress(), false, false, false, false);
    await campaign.connect(alice).buyExactTokens(amountOut, total, { value: total });
    await token.connect(alice).approve(await campaign.getAddress(), amountOut);

    await factory.connect(owner).setCampaignPauses(await campaign.getAddress(), false, false, true, false);
    await expect(campaign.connect(alice).sellExactTokens(ethers.parseEther("1"), 0n)).to.be.revertedWithCustomError(
      campaign,
      "SellsPaused"
    );
  });

  it("graduation pause blocks eligible permissionless finalization", async () => {
    const { factory, campaign, owner, alice, priceFeed } = await loadFixture(createCampaignFixture);
    const amountOut = ethers.parseEther("1");
    const total = await campaign.quoteBuyExactTokens(amountOut);

    await campaign.connect(alice).buyExactTokens(amountOut, total, { value: total });
    await makeGraduationEligibleByOracle(campaign, priceFeed);
    await factory.connect(owner).setCampaignPauses(await campaign.getAddress(), false, false, false, true);

    // EVM launch generation: graduate() replaces graduateIfEligible(). Audit 2: under a graduation pause the
    // due campaign is still marked Pending (the call returns instead of reverting, so the 72 h clock starts),
    // but no pool is built; a second call while the pause is honoured reverts.
    await expect(campaign.connect(alice).graduate()).to.emit(campaign, "GraduationPending");
    expect(await campaign.graduationPending()).to.eq(true);
    expect(await campaign.launched()).to.eq(false);
    await expect(campaign.connect(alice).graduate()).to.be.revertedWithCustomError(campaign, "GraduationPaused");

    await factory.connect(owner).setCampaignPauses(await campaign.getAddress(), false, false, false, false);
    await expect(campaign.connect(alice).graduate()).to.emit(campaign, "Graduated");
    expect(await campaign.launched()).to.eq(true);
  });

  it("authorized-trading toggle blocks direct buys and sells until disabled", async () => {
    const { factory, campaign, token, owner, alice } = await loadFixture(createHighTargetCampaignFixture);
    const amountOut = ethers.parseEther("2");
    const total = await campaign.quoteBuyExactTokens(amountOut);

    await expect(factory.connect(owner).setCampaignRequireAuthorizedTrading(await campaign.getAddress(), true))
      .to.emit(campaign, "RequireAuthorizedTradingUpdated")
      .withArgs(true);

    await expect(campaign.connect(alice).buyExactTokens(amountOut, total, { value: total })).to.be.revertedWithCustomError(
      campaign,
      "AuthorizedTradingRequired"
    );

    await factory.connect(owner).setCampaignRequireAuthorizedTrading(await campaign.getAddress(), false);
    await campaign.connect(alice).buyExactTokens(amountOut, total, { value: total });
    await token.connect(alice).approve(await campaign.getAddress(), amountOut);

    await factory.connect(owner).setCampaignRequireAuthorizedTrading(await campaign.getAddress(), true);
    await expect(campaign.connect(alice).sellExactTokens(ethers.parseEther("1"), 0n)).to.be.revertedWithCustomError(
      campaign,
      "AuthorizedTradingRequired"
    );
  });

  it("reports empty graduation state before finalization", async () => {
    const { campaign } = await loadFixture(createCampaignFixture);
    const state = await campaign.getGraduationState();

    expect(state.dexPair).to.eq(ethers.ZeroAddress);
    expect(state.finalCurvePrice).to.eq(0n);
    expect(state.initialDexPrice).to.eq(0n);
    expect(state.graduatedLiquidityTokens).to.eq(0n);
    expect(state.graduatedLiquidityBnb).to.eq(0n);
    expect(state.graduatedLiquidityLp).to.eq(0n);
    expect(state.burnedUnsoldTokens).to.eq(0n);
    expect(state.burnedUnusedLpTokens).to.eq(0n);
    expect(state.postBurnTotalSupply).to.eq(0n);
    expect(state.graduationBalance).to.eq(0n);
    expect(state.graduationOvershoot).to.eq(0n);
  });

  it("finalization records state, uses Topaz liquidity, registers LP with the permanent locker, and is idempotent", async () => {
    const { campaign, token, alice, bob, factory, permanentLpLocker, v2factory, graduationAdapter, protocolVault } =
      await loadFixture(createLowTargetCampaignFixture);
    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);

    // EVM launch generation (C5): the crossing buy only marks Pending; graduate() is a separate permissionless call.
    const buy = campaign.connect(alice).buyExactTokens(curveSupply, totalBuy, { value: totalBuy });
    await expect(buy).to.emit(campaign, "GraduationPending");
    await expect(buy).to.not.emit(campaign, "Graduated");
    expect(await campaign.graduationPending()).to.eq(true);
    expect(await campaign.launched()).to.eq(false);

    const pre = await campaign.getGraduationState();
    const R: bigint = pre.graduationBalance;
    const P: bigint = pre.finalCurvePrice;
    const protocolShare = (R * 220n) / 10000n;
    const creatorShare = (R * 1980n) / 10000n;
    const poolNative = R - protocolShare - creatorShare;
    const memeTarget = (poolNative * 10n ** 18n) / P;
    const budget = (await campaign.totalSupply()) - (await campaign.creatorReserve()) - (await campaign.sold());
    const protocolBefore = await ethers.provider.getBalance(await protocolVault.getAddress());

    const tx = campaign.connect(bob).graduate();
    await expect(tx)
      .to.emit(campaign, "Graduated")
      .withArgs(
        (pool: string) => pool !== ethers.ZeroAddress,
        R,
        protocolShare,
        creatorShare,
        poolNative,
        memeTarget,
        budget - memeTarget,
        P,
        P,
        false
      );
    await expect(tx).to.emit(factory, "CampaignGraduated");

    const state = await campaign.getGraduationState();
    expect(await campaign.launched()).to.eq(true);
    expect(await campaign.graduationPending()).to.eq(false);
    expect(await campaign.finalizedAt()).to.be.gt(0n);
    // the pool is the Topaz pool for MEME/wrapped native on the router's pool factory
    expect(state.dexPair).to.eq(await v2factory.getPool(await token.getAddress(), await graduationAdapter.wrapped(), false));
    expect(state.graduatedLiquidityTokens).to.eq(memeTarget);
    expect(state.graduatedLiquidityBnb).to.eq(poolNative);
    expect(state.graduatedLiquidityLp).to.be.gt(0n);
    expect(state.burnedUnsoldTokens).to.eq(budget - memeTarget);
    expect(state.postBurnTotalSupply).to.eq(await token.totalSupply());
    expect(await token.balanceOf(state.dexPair)).to.eq(memeTarget);
    expect(await permanentLpLocker.registeredLpToken(state.dexPair)).to.eq(true);
    expect(await campaign.pendingCreatorGraduation()).to.eq(creatorShare);
    // the protocol 2.2% reached the protocol vault through routeFinalize (nothing escrowed)
    expect(await campaign.pendingProtocolGraduationFee()).to.eq(0n);
    expect(await ethers.provider.getBalance(await protocolVault.getAddress())).to.be.gt(protocolBefore);

    await expect(campaign.connect(alice).graduate()).to.be.revertedWithCustomError(campaign, "Finalized");
  });

  it("quoteBuyExactBnb returns zeros after finalization", async () => {
    const { campaign, alice } = await loadFixture(createLowTargetCampaignFixture);
    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);

    await campaign.connect(alice).buyExactTokens(curveSupply, totalBuy, { value: totalBuy });
    // EVM launch generation: sold out = Pending; zero while Pending and after graduate().
    const pending = await campaign.quoteBuyExactBnb(ethers.parseEther("1"));
    expect(pending.tokensOut).to.eq(0n);
    await campaign.connect(alice).graduate();
    expect(await campaign.launched()).to.eq(true);

    const quote = await campaign.quoteBuyExactBnb(ethers.parseEther("1"));
    expect(quote.tokensOut).to.eq(0n);
    expect(quote.totalCostWei).to.eq(0n);
    expect(quote.feeWei).to.eq(0n);
  });
});
