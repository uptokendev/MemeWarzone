import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { completeNativeGraduation, deployCoreFixture } from "./fixtures/core";

const baseCampaignRequest = (overrides: Record<string, unknown> = {}) => ({
  name: "ExcessNativeToken",
  symbol: "EXT",
  logoURI: "ipfs://excess-native-logo",
  xAccount: "x",
  website: "w",
  extraLink: "e",
  basePrice: 0n,
  priceSlope: 0n,
  graduationTarget: 0n,
  lpReceiver: ethers.ZeroAddress,
  ...overrides,
});

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
  return { ...fx, info, campaign };
}

describe("LaunchCampaign excess native rescue", function () {
  it("allows only finalized excess native balance to be rescued", async () => {
    const { campaign, owner, creator, alice, bob } = await loadFixture(createLowTargetCampaign);
    const surplus = ethers.parseEther("2");
    const bobAddress = await bob.getAddress();

    await expect(campaign.connect(creator).rescueExcessNative(bobAddress, 1n)).to.be.revertedWithCustomError(
      campaign,
      "NotFinalized"
    );
    expect(await campaign.excessNativeBalance()).to.eq(0n);

    await owner.sendTransaction({ to: await campaign.getAddress(), value: surplus });

    const curveSupply = await campaign.curveSupply();
    const totalBuy = await campaign.quoteBuyExactTokens(curveSupply);
    await campaign.connect(alice).buyExactTokens(curveSupply, totalBuy, { value: totalBuy });
    await completeNativeGraduation(campaign, alice);

    expect(await campaign.launched()).to.eq(true);
    expect(await campaign.excessNativeBalance()).to.eq(surplus);

    await expect(campaign.connect(creator).rescueExcessNative(ethers.ZeroAddress, surplus)).to.be.revertedWithCustomError(
      campaign,
      "RescueRecipientZero"
    );
    await expect(campaign.connect(creator).rescueExcessNative(bobAddress, surplus + 1n)).to.be.revertedWithCustomError(
      campaign,
      "ExcessNativeUnavailable"
    );
    await expect(campaign.connect(alice).rescueExcessNative(bobAddress, surplus)).to.be.revertedWithCustomError(
      campaign,
      "OwnableUnauthorizedAccount"
    );

    await expect(() => campaign.connect(creator).rescueExcessNative(bobAddress, surplus)).to.changeEtherBalances(
      [campaign, bob],
      [-surplus, surplus]
    );
    expect(await campaign.excessNativeBalance()).to.eq(0n);
  });
});
