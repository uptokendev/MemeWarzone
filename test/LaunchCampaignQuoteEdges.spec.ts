import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployCoreFixture } from "./fixtures/core";

const TOKEN_UNIT = ethers.parseEther("1");

const baseCampaignRequest = (overrides: Record<string, unknown> = {}) => ({
  name: "QuoteToken",
  symbol: "QUOTE",
  logoURI: "ipfs://quote-logo",
  xAccount: "",
  website: "",
  extraLink: "",
  // EVM launch generation: 0 = the fixture default ($1 = 1 native at the $1 oracle). The old $100k target is
  // refused at create (TargetOutOfRangeAtPrice: above 95% of what the whole curve raises).
  graduationTarget: 0n,
  firstBuyTokens: 0n,
  firstBuyMaxCost: 0n,
  feeChoice: 1,
  feeCreatorPct: 0,
  ...overrides,
});

async function createCampaignFixture() {
  const fx = await deployCoreFixture();
  await fx.factory.connect(fx.creator).createCampaign(baseCampaignRequest() as any);
  const info = await fx.factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);
  // Past the C2 anti-sniper window: flat 2% fee, so a quote and the next block's execution agree.
  await time.increase(61);
  return { ...fx, info, campaign, token };
}

describe("LaunchCampaign quote edge behavior", function () {
  it("quoteBuyExactBnb returns zero when input is below an executable token unit", async () => {
    const { campaign } = await loadFixture(createCampaignFixture);
    const tokenUnitCost = await campaign.quoteBuyExactTokens(TOKEN_UNIT);
    const quote = await campaign.quoteBuyExactBnb(tokenUnitCost - 1n);

    expect(tokenUnitCost).to.be.gt(0n);
    expect(quote.tokensOut).to.be.lt(TOKEN_UNIT);
    expect(quote.totalCostWei).to.be.lt(tokenUnitCost);
    expect(quote.feeWei).to.be.lte(quote.totalCostWei);
  });

  it("quoteBuyExactBnb can afford at least the exact token unit quoted by quoteBuyExactTokens", async () => {
    const { campaign } = await loadFixture(createCampaignFixture);
    const exactCost = await campaign.quoteBuyExactTokens(TOKEN_UNIT);
    const quote = await campaign.quoteBuyExactBnb(exactCost);

    expect(quote.tokensOut).to.be.gte(TOKEN_UNIT);
    expect(quote.totalCostWei).to.be.lte(exactCost);
    expect(quote.feeWei).to.be.lte(quote.totalCostWei);
  });

  it("quoteBuyExactBnb is read-only and does not mutate buyer counters or sold supply", async () => {
    const { campaign, alice } = await loadFixture(createCampaignFixture);
    const value = await campaign.quoteBuyExactTokens(TOKEN_UNIT);

    const beforeSold = await campaign.sold();
    const beforeBuyers = await campaign.buyersCount();
    const beforeHasBought = await campaign.hasBought(await alice.getAddress());

    const quote = await campaign.quoteBuyExactBnb(value);
    expect(quote.tokensOut).to.be.gte(TOKEN_UNIT);

    expect(await campaign.sold()).to.eq(beforeSold);
    expect(await campaign.buyersCount()).to.eq(beforeBuyers);
    expect(await campaign.hasBought(await alice.getAddress())).to.eq(beforeHasBought);
  });

  it("quoteBuyExactBnb decreases remaining output after a buy advances sold supply", async () => {
    const { campaign, alice } = await loadFixture(createCampaignFixture);
    const value = await campaign.quoteBuyExactTokens(ethers.parseEther("10"));
    const before = await campaign.quoteBuyExactBnb(value);

    await campaign.connect(alice).buyExactBnb(1n, { value });
    const after = await campaign.quoteBuyExactBnb(value);

    expect(before.tokensOut).to.be.gt(0n);
    expect(after.tokensOut).to.be.lt(before.tokensOut);
  });

  it("quoteBuyExactBnb caps output at remaining curve supply", async () => {
    const { campaign } = await loadFixture(createCampaignFixture);
    const curveSupply = await campaign.curveSupply();
    const fullCurveCost = await campaign.quoteBuyExactTokens(curveSupply);
    const quote = await campaign.quoteBuyExactBnb(fullCurveCost + ethers.parseEther("100"));

    expect(quote.tokensOut).to.eq(curveSupply);
    expect(quote.totalCostWei).to.eq(fullCurveCost);
  });

  it("quoteBuyExactBnb returns zero when all curve tokens are sold before graduation", async () => {
    const { campaign, alice } = await loadFixture(createCampaignFixture);
    const curveSupply = await campaign.curveSupply();
    const fullCurveCost = await campaign.quoteBuyExactTokens(curveSupply);

    // EVM launch generation (C5): selling out marks Pending (trigger 1) and does not graduate in the buy.
    await expect(campaign.connect(alice).buyExactTokens(curveSupply, fullCurveCost, { value: fullCurveCost })).to.emit(
      campaign,
      "GraduationPending"
    );
    expect(await campaign.launched()).to.eq(false);
    expect(await campaign.graduationPending()).to.eq(true);
    expect(await campaign.pendingTrigger()).to.eq(1);
    expect(await campaign.sold()).to.eq(curveSupply);

    const quote = await campaign.quoteBuyExactBnb(ethers.parseEther("1"));
    expect(quote.tokensOut).to.eq(0n);
    expect(quote.totalCostWei).to.eq(0n);
    expect(quote.feeWei).to.eq(0n);
    await expect(campaign.quoteBuyExactTokens(1n)).to.be.revertedWithCustomError(campaign, "SoldOut");
  });

  it("quoteBuyExactBnb returns zero after all curve tokens are sold and finalized", async () => {
    const fx = await createCampaignFixture();
    const { campaign } = fx;
    const curveSupply = await campaign.curveSupply();
    const fullCurveCost = await campaign.quoteBuyExactTokens(curveSupply);

    await campaign.connect(fx.alice).buyExactTokens(curveSupply, fullCurveCost, { value: fullCurveCost });
    // EVM launch generation (C5): the sold-out buy marks Pending; graduate() is the separate permissionless step.
    expect(await campaign.graduationPending()).to.eq(true);
    await expect(campaign.connect(fx.bob).graduate()).to.emit(campaign, "Graduated");
    expect(await campaign.launched()).to.eq(true);

    const quote = await campaign.quoteBuyExactBnb(ethers.parseEther("1"));
    expect(quote.tokensOut).to.eq(0n);
    expect(quote.totalCostWei).to.eq(0n);
    expect(quote.feeWei).to.eq(0n);
  });
});
