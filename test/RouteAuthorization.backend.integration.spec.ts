import { expect } from "chai";
import { ethers } from "hardhat";
import { deployRoutedLaunchFactory } from "./helpers/deployRouting";

const TRADE_AUTH_BUY_EXACT_TOKENS = 0;

async function signerHelpers() {
  return import("../frontend/api/dev-fix/routeAuthorizationSigner.js");
}

async function currentDeadline(offset = 3600) {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("missing latest block");
  return BigInt(block.timestamp + offset);
}

describe("backend route-authorization integration", function () {
  it("submits signatures from the dependency-free backend helper to the deployed factory and campaign", async () => {
    const [admin, routeAuthority, creator, buyer] = await ethers.getSigners();
    const { signCreateAuthorization, signTradeAuthorization } = await signerHelpers();
    const { factory } = await deployRoutedLaunchFactory(admin);

    await factory.connect(admin).setRouteAuthority(routeAuthority.address);
    await factory.connect(admin).enableLive();

    const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
    const request = {
      name: "Backend Route Auth",
      symbol: "BRA",
      logoURI: "ipfs://backend-route-auth",
      xAccount: "",
      website: "",
      extraLink: "",
      graduationTarget: 0n,
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: 1,
      feeCreatorPct: 0,
    };
    const deadline = await currentDeadline();
    const createSignature = await signCreateAuthorization({
      signer: routeAuthority,
      chainId,
      factoryAddress: await factory.getAddress(),
      creator: creator.address,
      request,
      tradeRouteProfileId: 1,
      finalizeRouteProfileId: 1,
      deadline,
    });

    await expect(
      factory.connect(creator).createCampaignAuthorized(request, {
        tradeRouteProfile: 1,
        finalizeRouteProfile: 1,
        deadline,
        signature: createSignature,
      }),
    ).to.emit(factory, "CampaignCreated");

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const amountOut = ethers.parseEther("1");
    const maxCost = await campaign.quoteBuyExactTokens(amountOut);
    const tradeDeadline = await currentDeadline();
    const tradeSignature = await signTradeAuthorization({
      signer: routeAuthority,
      chainId,
      campaignAddress: await campaign.getAddress(),
      actor: buyer.address,
      routeProfileId: 1,
      action: TRADE_AUTH_BUY_EXACT_TOKENS,
      amount: amountOut,
      limit: maxCost,
      deadline: tradeDeadline,
    });

    await expect(
      campaign.connect(buyer).buyExactTokensAuthorized(amountOut, maxCost, 1, tradeDeadline, tradeSignature, { value: maxCost }),
    ).to.emit(campaign, "TokensPurchased");
  });

  it("rejects a backend signature when an operation-bound value is changed", async () => {
    const [admin, routeAuthority, creator, buyer] = await ethers.getSigners();
    const { signCreateAuthorization, signTradeAuthorization } = await signerHelpers();
    const { factory } = await deployRoutedLaunchFactory(admin);

    await factory.connect(admin).setRouteAuthority(routeAuthority.address);
    await factory.connect(admin).enableLive();

    const chainId = BigInt((await ethers.provider.getNetwork()).chainId);
    const request = {
      name: "Backend Route Auth Reject",
      symbol: "BRR",
      logoURI: "ipfs://backend-route-auth-reject",
      xAccount: "",
      website: "",
      extraLink: "",
      graduationTarget: 0n,
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: 1,
      feeCreatorPct: 0,
    };
    const createDeadline = await currentDeadline();
    const createSignature = await signCreateAuthorization({
      signer: routeAuthority,
      chainId,
      factoryAddress: await factory.getAddress(),
      creator: creator.address,
      request,
      tradeRouteProfileId: 1,
      finalizeRouteProfileId: 1,
      deadline: createDeadline,
    });

    await factory.connect(creator).createCampaignAuthorized(request, {
      tradeRouteProfile: 1,
      finalizeRouteProfile: 1,
      deadline: createDeadline,
      signature: createSignature,
    });

    const info = await factory.getCampaign(0n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const amountOut = ethers.parseEther("1");
    const tamperedAmountOut = ethers.parseEther("2");
    const maxCost = await campaign.quoteBuyExactTokens(amountOut);
    const tamperedMaxCost = await campaign.quoteBuyExactTokens(tamperedAmountOut);
    const tradeDeadline = await currentDeadline();
    const tradeSignature = await signTradeAuthorization({
      signer: routeAuthority,
      chainId,
      campaignAddress: await campaign.getAddress(),
      actor: buyer.address,
      routeProfileId: 1,
      action: TRADE_AUTH_BUY_EXACT_TOKENS,
      amount: amountOut,
      limit: maxCost,
      deadline: tradeDeadline,
    });

    await expect(
      campaign.connect(buyer).buyExactTokensAuthorized(tamperedAmountOut, tamperedMaxCost, 1, tradeDeadline, tradeSignature, {
        value: tamperedMaxCost,
      }),
    ).to.be.revertedWithCustomError(campaign, "BadRouteAuth");
  });
});
