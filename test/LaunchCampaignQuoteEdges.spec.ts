import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { completeNativeGraduation, deployCoreFixture } from "./fixtures/core";

const TOKEN_UNIT = ethers.parseEther("1");

const baseCampaignRequest = (overrides: Record<string, unknown> = {}) => ({
  name: "QuoteToken",
  symbol: "QUOTE",
  logoURI: "ipfs://quote-logo",
  xAccount: "",
  website: "",
  extraLink: "",
  basePrice: 0n,
  priceSlope: 0n,
  graduationTarget: ethers.parseEther("100000"),
  lpReceiver: ethers.ZeroAddress,
  ...overrides,
});

async function createCampaignFixture() {
  const fx = await deployCoreFixture();
  await fx.factory.connect(fx.creator).createCampaign(baseCampaignRequest() as any);
  const info = await fx.factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);
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

    await campaign.connect(alice).buyExactTokens(curveSupply, fullCurveCost, { value: fullCurveCost });
    expect(await campaign.launched()).to.eq(false);
    expect(await campaign.sold()).to.eq(curveSupply);

    const quote = await campaign.quoteBuyExactBnb(ethers.parseEther("1"));
    expect(quote.tokensOut).to.eq(0n);
    expect(quote.totalCostWei).to.eq(0n);
    expect(quote.feeWei).to.eq(0n);
    await expect(campaign.quoteBuyExactTokens(1n)).to.be.revertedWithCustomError(campaign, "SoldOut");
  });

  it("quoteBuyExactBnb returns zero after all curve tokens are sold and finalized", async () => {
    const fx = await deployCoreFixture();
    await fx.factory.connect(fx.owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000,
      liquidityTokenBps: 4000,
      basePrice: 10n ** 12n,
      priceSlope: 10n ** 9n,
      graduationTarget: 1n,
      liquidityBps: 8000,
    });
    await fx.factory.connect(fx.creator).createCampaign(baseCampaignRequest({ graduationTarget: 0n }) as any);
    const info = await fx.factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const curveSupply = await campaign.curveSupply();
    const fullCurveCost = await campaign.quoteBuyExactTokens(curveSupply);

    await campaign.connect(fx.alice).buyExactTokens(curveSupply, fullCurveCost, { value: fullCurveCost });
    await completeNativeGraduation(campaign, fx.alice);
    expect(await campaign.launched()).to.eq(true);

    const quote = await campaign.quoteBuyExactBnb(ethers.parseEther("1"));
    expect(quote.tokensOut).to.eq(0n);
    expect(quote.totalCostWei).to.eq(0n);
    expect(quote.feeWei).to.eq(0n);
  });
});
