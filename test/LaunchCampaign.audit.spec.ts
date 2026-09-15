import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { completeNativeGraduation, deployCoreFixture } from "./fixtures/core";
import { quoteBuyExactTokens } from "./helpers/math";

const baseCampaignRequest = (overrides: Record<string, unknown> = {}) => ({
  name: "AuditToken",
  symbol: "AUD",
  logoURI: "ipfs://audit-logo",
  xAccount: "x",
  website: "w",
  extraLink: "e",
  basePrice: 0n,
  priceSlope: 0n,
  graduationTarget: 0n,
  lpReceiver: ethers.ZeroAddress,
  ...overrides,
});

async function createCampaign(overrides: Record<string, unknown> = {}) {
  const fx = await deployCoreFixture();
  await fx.factory.connect(fx.creator).createCampaign(baseCampaignRequest(overrides) as any);
  const info = await fx.factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", await campaign.token());
  return { ...fx, info, campaign, token };
}

async function createLowTargetCampaign() {
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
  await fx.factory.connect(fx.creator).createCampaign(baseCampaignRequest() as any);
  const info = await fx.factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", await campaign.token());
  return { ...fx, info, campaign, token };
}

describe("LaunchCampaign audit hardening", function () {
  it("does not count direct native transfers toward graduation", async () => {
    const { campaign, owner, alice } = await loadFixture(createCampaign);

    const target = await campaign.graduationNativeTarget();
    await owner.sendTransaction({ to: await campaign.getAddress(), value: target });

    expect(await campaign.netRaisedWei()).to.eq(0n);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.eq(target);
    await expect(campaign.connect(alice).graduateIfEligible(0, 0)).to.be.revertedWithCustomError(campaign, "ThresholdNotMet");
    expect(await campaign.launched()).to.eq(false);
  });

  it("leaves direct native surplus out of creator payout at graduation", async () => {
    const { campaign, owner, alice } = await loadFixture(createLowTargetCampaign);

    const surplus = ethers.parseEther("2");
    await owner.sendTransaction({ to: await campaign.getAddress(), value: surplus });

    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);
    await campaign.connect(alice).buyExactTokens(curveSupply, totalBuy, { value: totalBuy });
    const completeTx = await completeNativeGraduation(campaign, alice);
    await expect(completeTx).to.emit(campaign, "CampaignFinalized");

    expect(await campaign.launched()).to.eq(true);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.eq(surplus);
  });

  it("escrows unified router failures instead of blocking buys", async () => {
    const { campaign, token, alice, treasuryRouter, owner } = await loadFixture(createCampaign);

    await treasuryRouter.connect(owner).setForwardingPaused(true);

    const amountOut = ethers.parseEther("10");
    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();
    const feeBps = await campaign.protocolFeeBps();
    const sold0 = await campaign.sold();
    const { costNoFee, fee, total } = quoteBuyExactTokens(
      BigInt(sold0),
      BigInt(amountOut),
      BigInt(base),
      BigInt(slope),
      BigInt(feeBps)
    );

    const tx = await campaign.connect(alice).buyExactTokens(amountOut, total, { value: total });

    expect(await token.balanceOf(await alice.getAddress())).to.eq(amountOut);
    expect(await campaign.netRaisedWei()).to.eq(costNoFee);
    await expect(tx).to.emit(campaign, "NativeEscrowed").withArgs(await treasuryRouter.getAddress(), fee);
    expect(await campaign.pendingNative(await treasuryRouter.getAddress())).to.eq(fee);
    expect(await campaign.pendingNativeTotal()).to.eq(fee);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.eq(costNoFee + fee);
  });
});
