import { expect } from "chai";
import { ethers } from "hardhat";
import { deployCoreFixture } from "./fixtures/core";

const MAX_BPS = 10_000n;

const baseReq = (overrides: Record<string, unknown> = {}) => ({
  name: "SupplyBounded",
  symbol: "SBND",
  logoURI: "ipfs://supply-bounded",
  xAccount: "",
  website: "",
  extraLink: "",
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

describe("LaunchFactory supply bounds", function () {
  it("rejects total supply above the documented maximum", async () => {
    const { factory, owner } = await deployCoreFixture();
    const maxTotalSupply = await factory.MAX_TOTAL_SUPPLY();

    await expect(
      factory.connect(owner).setConfig({
        totalSupply: maxTotalSupply + 1n,
        curveBps: 6000n,
        liquidityTokenBps: 3000n,
        basePrice: 1n,
        priceSlope: 1n,
        graduationTarget: 1n,
        firstBuyTokens: 0n,
        firstBuyMaxCost: 0n,
        feeChoice: 1,
        feeCreatorPct: 0,
        liquidityBps: 8000n,
      })
    ).to.be.revertedWithCustomError(factory, "ParamTooHigh");
  });

  it("accepts the maximum total supply and keeps curve math usable near the cap", async () => {
    const { factory, owner, creator } = await deployCoreFixture();
    const maxTotalSupply = await factory.MAX_TOTAL_SUPPLY();
    const curveBps = 6000n;
    const liquidityTokenBps = 3000n;

    await expect(
      factory.connect(owner).setConfig({
        totalSupply: maxTotalSupply,
        curveBps,
        liquidityTokenBps,
        basePrice: 1n,
        priceSlope: 1n,
        graduationTarget: 1n,
        firstBuyTokens: 0n,
        firstBuyMaxCost: 0n,
        feeChoice: 1,
        feeCreatorPct: 0,
        liquidityBps: 8000n,
      })
    ).to.emit(factory, "ConfigUpdated");

    await factory.connect(creator).createCampaign(baseReq() as any);
    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const curveSupply = (maxTotalSupply * curveBps) / MAX_BPS;

    expect(await campaign.totalSupply()).to.equal(maxTotalSupply);
    expect(await campaign.curveSupply()).to.equal(curveSupply);
    expect(await campaign.quoteBuyExactTokens(curveSupply)).to.be.gt(0n);
  });
});
