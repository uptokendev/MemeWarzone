import { expect } from "chai";
import { ethers } from "hardhat";
import { createCoin, deployEvmGen, req } from "./fixtures/evmgenCore";

const ACTION_BUY_EXACT_TOKENS = 0;
const ACTION_BUY_EXACT_BNB = 1;
const ACTION_SELL_EXACT_TOKENS = 2;
const ROUTE_PROFILE_STANDARD_UNLINKED = 1;
const INVALID_ROUTE_PROFILE = 99;

// EVM launch generation (E7): block-based launch protection (setLaunchProtectionConfig, protected blocks,
// per-buy / per-wallet caps) was removed and replaced by the C2 anti-sniper fee. The route-authorization
// properties these flows guarded still hold on the trade path at every point of the window, so they are
// pinned here on a generation-6 coin inside the anti-sniper window (production defaults: authorized
// trading required).
async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function deployProtectedLaunchFixture(options: { setRouteAuthority?: boolean } = {}) {
  const env = await deployEvmGen();
  const { campaign, token } = await createCoin(env, req({ name: "Protected Token", symbol: "PROT" }));
  if (options.setRouteAuthority === false) await env.factory.setRouteAuthority(ethers.ZeroAddress);
  // still inside the C2 window: the fee has not decayed to the flat protocol fee yet
  expect(await campaign.currentTradeFeeBps()).to.be.gt(await campaign.protocolFeeBps());
  return { creator: env.creator, buyer: env.alice, routeAuthority: env.authority, attacker: env.bob, factory: env.factory, campaign, token };
}

async function signTradeRoute(params: {
  campaign: any;
  actor: string;
  signer: any;
  routeProfile: number;
  action: number;
  amount: bigint;
  limit: bigint;
  deadline: bigint;
}) {
  const { chainId } = await ethers.provider.getNetwork();
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "uint8", "uint8", "uint256", "uint256", "uint64"],
      [
        "MWZ_ROUTE_TRADE_AUTH",
        chainId,
        await params.campaign.getAddress(),
        params.actor,
        params.routeProfile,
        params.action,
        params.amount,
        params.limit,
        params.deadline,
      ]
    )
  );
  return params.signer.signMessage(ethers.getBytes(digest));
}

describe("BNB launch protection trade flows (route authorization inside the C2 anti-sniper window)", function () {
  it("allows authorized exact-BNB buys and blocks direct buys during the anti-sniper window", async function () {
    const { buyer, routeAuthority, campaign } = await deployProtectedLaunchFixture();
    const totalIn = ethers.parseEther("0.00001");
    const quote = await campaign.quoteBuyExactBnb(totalIn);
    const minTokensOut = quote[0];
    const deadline = (await latestTimestamp()) + 3600n;

    expect(minTokensOut).to.be.gt(0n);

    await expect(campaign.connect(buyer).buyExactBnb(minTokensOut, { value: totalIn })).to.be.revertedWithCustomError(
      campaign,
      "AuthorizedTradingRequired"
    );

    const signature = await signTradeRoute({
      campaign,
      actor: buyer.address,
      signer: routeAuthority,
      routeProfile: ROUTE_PROFILE_STANDARD_UNLINKED,
      action: ACTION_BUY_EXACT_BNB,
      amount: totalIn,
      limit: minTokensOut,
      deadline,
    });

    await expect(
      campaign
        .connect(buyer)
        .buyExactBnbAuthorized(minTokensOut, ROUTE_PROFILE_STANDARD_UNLINKED, deadline, signature, { value: totalIn })
    ).to.emit(campaign, "TokensPurchased");
  });

  it("rejects trade routes when no route authority is configured", async function () {
    const { buyer, routeAuthority, campaign } = await deployProtectedLaunchFixture({ setRouteAuthority: false });
    const amountOut = ethers.parseEther("1");
    const maxCost = await campaign.quoteBuyExactTokens(amountOut);
    const deadline = (await latestTimestamp()) + 3600n;
    const signature = await signTradeRoute({
      campaign,
      actor: buyer.address,
      signer: routeAuthority,
      routeProfile: ROUTE_PROFILE_STANDARD_UNLINKED,
      action: ACTION_BUY_EXACT_TOKENS,
      amount: amountOut,
      limit: maxCost,
      deadline,
    });

    await expect(
      campaign
        .connect(buyer)
        .buyExactTokensAuthorized(amountOut, maxCost, ROUTE_PROFILE_STANDARD_UNLINKED, deadline, signature, { value: maxCost })
    ).to.be.revertedWithCustomError(campaign, "RouteAuthUnavailable");
  });

  it("rejects invalid trade route profiles", async function () {
    const { buyer, routeAuthority, campaign } = await deployProtectedLaunchFixture();
    const amountOut = ethers.parseEther("1");
    const maxCost = await campaign.quoteBuyExactTokens(amountOut);
    const deadline = (await latestTimestamp()) + 3600n;
    const signature = await signTradeRoute({
      campaign,
      actor: buyer.address,
      signer: routeAuthority,
      routeProfile: INVALID_ROUTE_PROFILE,
      action: ACTION_BUY_EXACT_TOKENS,
      amount: amountOut,
      limit: maxCost,
      deadline,
    });

    await expect(
      campaign.connect(buyer).buyExactTokensAuthorized(amountOut, maxCost, INVALID_ROUTE_PROFILE, deadline, signature, { value: maxCost })
    ).to.be.revertedWithCustomError(campaign, "InvalidTradeRouteProfile");
  });

  it("rejects expired trade routes before accepting funds", async function () {
    const { buyer, routeAuthority, campaign } = await deployProtectedLaunchFixture();
    const amountOut = ethers.parseEther("1");
    const maxCost = await campaign.quoteBuyExactTokens(amountOut);
    const expiredDeadline = (await latestTimestamp()) - 1n;
    const signature = await signTradeRoute({
      campaign,
      actor: buyer.address,
      signer: routeAuthority,
      routeProfile: ROUTE_PROFILE_STANDARD_UNLINKED,
      action: ACTION_BUY_EXACT_TOKENS,
      amount: amountOut,
      limit: maxCost,
      deadline: expiredDeadline,
    });

    await expect(
      campaign
        .connect(buyer)
        .buyExactTokensAuthorized(amountOut, maxCost, ROUTE_PROFILE_STANDARD_UNLINKED, expiredDeadline, signature, { value: maxCost })
    ).to.be.revertedWithCustomError(campaign, "RouteAuthExpired");
  });

  it("keeps sells route-gated during the anti-sniper window while allowing authorized exits", async function () {
    const { buyer, routeAuthority, campaign, token } = await deployProtectedLaunchFixture();
    const amountOut = ethers.parseEther("2");
    const maxCost = await campaign.quoteBuyExactTokens(amountOut);
    const buyDeadline = (await latestTimestamp()) + 3600n;
    const buySignature = await signTradeRoute({
      campaign,
      actor: buyer.address,
      signer: routeAuthority,
      routeProfile: ROUTE_PROFILE_STANDARD_UNLINKED,
      action: ACTION_BUY_EXACT_TOKENS,
      amount: amountOut,
      limit: maxCost,
      deadline: buyDeadline,
    });

    await campaign
      .connect(buyer)
      .buyExactTokensAuthorized(amountOut, maxCost, ROUTE_PROFILE_STANDARD_UNLINKED, buyDeadline, buySignature, { value: maxCost });
    await token.connect(buyer).approve(await campaign.getAddress(), amountOut);

    await expect(campaign.connect(buyer).sellExactTokens(amountOut, 0)).to.be.revertedWithCustomError(
      campaign,
      "AuthorizedTradingRequired"
    );

    const sellDeadline = (await latestTimestamp()) + 3600n;
    const sellSignature = await signTradeRoute({
      campaign,
      actor: buyer.address,
      signer: routeAuthority,
      routeProfile: ROUTE_PROFILE_STANDARD_UNLINKED,
      action: ACTION_SELL_EXACT_TOKENS,
      amount: amountOut,
      limit: 0n,
      deadline: sellDeadline,
    });

    await expect(
      campaign.connect(buyer).sellExactTokensAuthorized(amountOut, 0, ROUTE_PROFILE_STANDARD_UNLINKED, sellDeadline, sellSignature)
    ).to.emit(campaign, "TokensSold");
  });

  it("rejects sell route signatures from the wrong signer or for the wrong action and limit", async function () {
    const { buyer, routeAuthority, attacker, campaign, token } = await deployProtectedLaunchFixture();
    const amountOut = ethers.parseEther("2");
    const maxCost = await campaign.quoteBuyExactTokens(amountOut);
    const buyDeadline = (await latestTimestamp()) + 3600n;
    const buySignature = await signTradeRoute({
      campaign,
      actor: buyer.address,
      signer: routeAuthority,
      routeProfile: ROUTE_PROFILE_STANDARD_UNLINKED,
      action: ACTION_BUY_EXACT_TOKENS,
      amount: amountOut,
      limit: maxCost,
      deadline: buyDeadline,
    });

    await campaign
      .connect(buyer)
      .buyExactTokensAuthorized(amountOut, maxCost, ROUTE_PROFILE_STANDARD_UNLINKED, buyDeadline, buySignature, { value: maxCost });
    await token.connect(buyer).approve(await campaign.getAddress(), amountOut);

    const sellDeadline = (await latestTimestamp()) + 3600n;
    const badSignerSignature = await signTradeRoute({
      campaign,
      actor: buyer.address,
      signer: attacker,
      routeProfile: ROUTE_PROFILE_STANDARD_UNLINKED,
      action: ACTION_SELL_EXACT_TOKENS,
      amount: amountOut,
      limit: 0n,
      deadline: sellDeadline,
    });
    await expect(
      campaign.connect(buyer).sellExactTokensAuthorized(amountOut, 0, ROUTE_PROFILE_STANDARD_UNLINKED, sellDeadline, badSignerSignature)
    ).to.be.revertedWithCustomError(campaign, "BadRouteAuth");

    const wrongActionSignature = await signTradeRoute({
      campaign,
      actor: buyer.address,
      signer: routeAuthority,
      routeProfile: ROUTE_PROFILE_STANDARD_UNLINKED,
      action: ACTION_BUY_EXACT_TOKENS,
      amount: amountOut,
      limit: 0n,
      deadline: sellDeadline,
    });
    await expect(
      campaign.connect(buyer).sellExactTokensAuthorized(amountOut, 0, ROUTE_PROFILE_STANDARD_UNLINKED, sellDeadline, wrongActionSignature)
    ).to.be.revertedWithCustomError(campaign, "BadRouteAuth");

    const wrongLimitSignature = await signTradeRoute({
      campaign,
      actor: buyer.address,
      signer: routeAuthority,
      routeProfile: ROUTE_PROFILE_STANDARD_UNLINKED,
      action: ACTION_SELL_EXACT_TOKENS,
      amount: amountOut,
      limit: 1n,
      deadline: sellDeadline,
    });
    await expect(
      campaign.connect(buyer).sellExactTokensAuthorized(amountOut, 0, ROUTE_PROFILE_STANDARD_UNLINKED, sellDeadline, wrongLimitSignature)
    ).to.be.revertedWithCustomError(campaign, "BadRouteAuth");

    const validSellSignature = await signTradeRoute({
      campaign,
      actor: buyer.address,
      signer: routeAuthority,
      routeProfile: ROUTE_PROFILE_STANDARD_UNLINKED,
      action: ACTION_SELL_EXACT_TOKENS,
      amount: amountOut,
      limit: 0n,
      deadline: sellDeadline,
    });
    await expect(
      campaign.connect(buyer).sellExactTokensAuthorized(amountOut, 0, ROUTE_PROFILE_STANDARD_UNLINKED, sellDeadline, validSellSignature)
    ).to.emit(campaign, "TokensSold");
  });

});
