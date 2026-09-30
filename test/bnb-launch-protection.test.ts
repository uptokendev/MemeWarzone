import { expect } from "chai";
import { ethers, network } from "hardhat";
import { deployRoutedLaunchFactory } from "./helpers/deployRouting";

const ACTION_BUY_EXACT_TOKENS = 0;
const ACTION_BUY_EXACT_BNB = 1;
const ACTION_SELL_EXACT_TOKENS = 2;
const ROUTE_PROFILE_STANDARD_UNLINKED = 1;
const INVALID_ROUTE_PROFILE = 99;

function campaignRequest(overrides: Record<string, unknown> = {}) {
  return {
    name: "Protected Token",
    symbol: "PROT",
    logoURI: "ipfs://protected-token-logo",
    xAccount: "@protected",
    website: "https://memewarzone.example/protected",
    extraLink: "https://memewarzone.example/docs",
    basePrice: 0,
    priceSlope: 0,
    graduationTarget: 0,
    firstBuyTokens: 0n,
    firstBuyMaxCost: 0n,
    feeChoice: 1,
    feeCreatorPct: 0,
    lpReceiver: ethers.ZeroAddress,
    ...overrides,
  };
}

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function minePastBlock(blockNumber: bigint) {
  while (BigInt(await ethers.provider.getBlockNumber()) <= blockNumber) {
    await network.provider.send("evm_mine");
  }
}

async function deployProtectedLaunchFixture(
  options: { setRouteAuthority?: boolean; protectionBlocks?: number; maxBuyWei?: bigint; maxWalletWei?: bigint } = {}
) {
  const [owner, creator, buyer, routeAuthority, attacker] = await ethers.getSigners();
  const { factory } = await deployRoutedLaunchFactory(owner);
  const setRouteAuthority = options.setRouteAuthority ?? true;
  const protectionBlocks = options.protectionBlocks ?? 30;
  const maxBuyWei = options.maxBuyWei ?? ethers.parseEther("1");
  const maxWalletWei = options.maxWalletWei ?? ethers.parseEther("1");

  if (setRouteAuthority) await factory.setRouteAuthority(routeAuthority.address);
  await factory.setLaunchProtectionConfig(protectionBlocks, maxBuyWei, maxWalletWei);
  await factory.enableLive();

  const tx = await factory.connect(creator).createCampaign(campaignRequest());
  await tx.wait();
  const info = await factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);

  return { creator, buyer, routeAuthority, attacker, factory, campaign, token };
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

describe("BNB launch protection trade flows", function () {
  it("allows authorized exact-BNB buys during protected launch blocks", async function () {
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

  it("enforces exact-BNB per-transaction buy caps during protected launch blocks", async function () {
    const { buyer, routeAuthority, campaign } = await deployProtectedLaunchFixture({ maxBuyWei: ethers.parseEther("0.000001") });
    const totalIn = ethers.parseEther("0.00001");
    const quote = await campaign.quoteBuyExactBnb(totalIn);
    const minTokensOut = quote[0];
    const deadline = (await latestTimestamp()) + 3600n;
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
    ).to.be.revertedWithCustomError(campaign, "LaunchProtectionBuyLimit");
  });

  it("tracks exact-BNB protected buys against the wallet cap across multiple buys", async function () {
    const { buyer, routeAuthority, campaign } = await deployProtectedLaunchFixture({ maxWalletWei: ethers.parseEther("0.000015") });
    const totalIn = ethers.parseEther("0.00001");
    const firstQuote = await campaign.quoteBuyExactBnb(totalIn);
    const firstMinTokensOut = firstQuote[0];
    const firstDeadline = (await latestTimestamp()) + 3600n;
    const firstSignature = await signTradeRoute({
      campaign,
      actor: buyer.address,
      signer: routeAuthority,
      routeProfile: ROUTE_PROFILE_STANDARD_UNLINKED,
      action: ACTION_BUY_EXACT_BNB,
      amount: totalIn,
      limit: firstMinTokensOut,
      deadline: firstDeadline,
    });

    await campaign
      .connect(buyer)
      .buyExactBnbAuthorized(firstMinTokensOut, ROUTE_PROFILE_STANDARD_UNLINKED, firstDeadline, firstSignature, { value: totalIn });

    const secondQuote = await campaign.quoteBuyExactBnb(totalIn);
    const secondMinTokensOut = secondQuote[0];
    const secondDeadline = (await latestTimestamp()) + 3600n;
    const secondSignature = await signTradeRoute({
      campaign,
      actor: buyer.address,
      signer: routeAuthority,
      routeProfile: ROUTE_PROFILE_STANDARD_UNLINKED,
      action: ACTION_BUY_EXACT_BNB,
      amount: totalIn,
      limit: secondMinTokensOut,
      deadline: secondDeadline,
    });

    await expect(
      campaign
        .connect(buyer)
        .buyExactBnbAuthorized(secondMinTokensOut, ROUTE_PROFILE_STANDARD_UNLINKED, secondDeadline, secondSignature, { value: totalIn })
    ).to.be.revertedWithCustomError(campaign, "LaunchProtectionWalletLimit");
  });

  it("rejects protected launch routes when no route authority is configured", async function () {
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

  it("rejects invalid protected launch route profiles", async function () {
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

  it("rejects expired protected launch trade routes before accepting funds", async function () {
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

  it("keeps sells route-gated during protected launch blocks while allowing authorized exits", async function () {
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

  it("returns to normal direct buy and sell behavior after launch protection expires", async function () {
    const { buyer, campaign, token } = await deployProtectedLaunchFixture({ protectionBlocks: 1 });
    await minePastBlock(await campaign.launchProtectionEndBlock());

    const amountOut = ethers.parseEther("2");
    const maxCost = await campaign.quoteBuyExactTokens(amountOut);
    await expect(campaign.connect(buyer).buyExactTokens(amountOut, maxCost, { value: maxCost })).to.emit(campaign, "TokensPurchased");

    await token.connect(buyer).approve(await campaign.getAddress(), amountOut);
    await expect(campaign.connect(buyer).sellExactTokens(amountOut, 0)).to.emit(campaign, "TokensSold");
  });
});
