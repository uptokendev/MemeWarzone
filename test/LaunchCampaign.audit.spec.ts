import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployCoreFixture } from "./fixtures/core";
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
    await expect(campaign.connect(alice).buyExactTokens(curveSupply, totalBuy, { value: totalBuy })).to.emit(
      campaign,
      "CampaignFinalized"
    );

    expect(await campaign.launched()).to.eq(true);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.eq(surplus);
  });

  it("a paused treasury router halts trading rather than escrowing the fee in the campaign", async () => {
    // Under strictFeeRouting -- which LaunchFactory sets on every campaign -- a
    // fee that cannot be routed reverts the whole trade. It used to be escrowed
    // into pendingNative and the buy allowed to continue, which left fees sitting
    // in the campaign waiting for someone to claim them.
    //
    // Operationally this means pausing the treasury router stops every buy and
    // sell across the launchpad. That is the intended trade: no fee ever sits in
    // limbo, and no trade completes whose fee did not reach its destinations.
    const { campaign, token, alice, treasuryRouter, owner } = await loadFixture(createCampaign);

    await treasuryRouter.connect(owner).setForwardingPaused(true);

    const amountOut = ethers.parseEther("10");
    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();
    const feeBps = await campaign.protocolFeeBps();
    const sold0 = await campaign.sold();
    const { total } = quoteBuyExactTokens(
      BigInt(sold0),
      BigInt(amountOut),
      BigInt(base),
      BigInt(slope),
      BigInt(feeBps)
    );

    await expect(campaign.connect(alice).buyExactTokens(amountOut, total, { value: total })).to.be.reverted;

    expect(await token.balanceOf(await alice.getAddress())).to.eq(0n);
    expect(await campaign.sold()).to.eq(sold0);
    expect(await campaign.netRaisedWei()).to.eq(0n);
    expect(await campaign.pendingNative(await treasuryRouter.getAddress())).to.eq(0n);
    expect(await campaign.pendingNativeTotal()).to.eq(0n);
    expect(await ethers.provider.getBalance(await campaign.getAddress())).to.eq(0n);

    // Unpause and the same buy goes through, so the halt is the pause and
    // nothing else.
    await treasuryRouter.connect(owner).setForwardingPaused(false);
    await campaign.connect(alice).buyExactTokens(amountOut, total, { value: total });
    expect(await token.balanceOf(await alice.getAddress())).to.eq(amountOut);
  });
});
