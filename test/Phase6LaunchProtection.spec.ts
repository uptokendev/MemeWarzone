import { expect } from "chai";
import { ethers } from "hardhat";
import { deployCoreFixture } from "./fixtures/core";

const TOKEN = ethers.parseEther("1");
const ROUTE_PROFILE = 1;
const TRADE_AUTH_BUY_EXACT_TOKENS = 0;
const TRADE_AUTH_SELL_EXACT_TOKENS = 2;
let routeDeadlineSalt = 0;

const req = (overrides: Record<string, unknown> = {}) => ({
  name: "ProtectedToken",
  symbol: "PROT",
  logoURI: "ipfs://logo",
  xAccount: "",
  website: "",
  extraLink: "",
  graduationTarget: 0n, // the fixture config's $1 target (1 native at the fixture's $1 oracle)
  firstBuyTokens: 0n,
  firstBuyMaxCost: 0n,
  feeChoice: 1,
  feeCreatorPct: 0,
  ...overrides,
});

// EVM launch generation (E7): block-based launch protection (setLaunchProtectionConfig, protected blocks,
// per-buy / per-wallet caps) was removed and replaced by the C2 anti-sniper fee (5000 bps at launchAt,
// linear to the flat fee at +60 s). The route-authorization guarantees these tests pinned now hold for
// the whole life of the coin: authorized trading is the production default, so the fixture (which turns
// it off for the historical direct-trade specs) turns it back on before the create.
async function createProtectedCampaign(overrides: Record<string, unknown> = {}) {
  const fixture = await deployCoreFixture();
  const { factory, owner, creator } = fixture;

  await factory.connect(owner).setRouteAuthority(await owner.getAddress());
  await factory.connect(owner).setRequireAuthorizedTrading(true);
  await factory.connect(creator).createCampaign(req(overrides) as any);

  const info = await factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", await campaign.token());

  return { ...fixture, campaign, token };
}

async function signRouteAuthorization(
  authority: any,
  campaignAddress: string,
  actorAddress: string,
  routeProfile: number,
  action: number,
  amount: bigint,
  limit: bigint,
  chainId: bigint,
  deadline: bigint
) {
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "uint8", "uint8", "uint256", "uint256", "uint64"],
      ["MWZ_ROUTE_TRADE_AUTH", chainId, campaignAddress, actorAddress, routeProfile, action, amount, limit, deadline]
    )
  );
  return authority.signMessage(ethers.getBytes(digest));
}

async function routeSignature(
  authority: any,
  campaign: any,
  actor: any,
  action: number,
  amount: bigint,
  limit: bigint,
  routeProfile = ROUTE_PROFILE
) {
  const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 600 + routeDeadlineSalt++);
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const signature = await signRouteAuthorization(
    authority,
    await campaign.getAddress(),
    await actor.getAddress(),
    routeProfile,
    action,
    amount,
    limit,
    chainId,
    deadline
  );
  return { deadline, signature, routeProfile };
}

async function buyAuthorized(campaign: any, authority: any, buyer: any, amount = TOKEN) {
  const quote = await campaign.quoteBuyExactTokens(amount);
  const auth = await routeSignature(authority, campaign, buyer, TRADE_AUTH_BUY_EXACT_TOKENS, amount, quote);
  return campaign.connect(buyer).buyExactTokensAuthorized(amount, quote, auth.routeProfile, auth.deadline, auth.signature, {
    value: quote,
  });
}

describe("Phase 6 launch protection", function () {
  it("blocks direct buys during the anti-sniper window and allows signed route buys", async () => {
    const { campaign, token, owner, alice } = await createProtectedCampaign();
    // inside the C2 anti-sniper window
    expect(await campaign.currentTradeFeeBps()).to.be.gt(await campaign.protocolFeeBps());
    await expect(
      campaign.connect(alice).buyExactBnb(0n, { value: ethers.parseEther("0.01") })
    ).to.be.revertedWithCustomError(campaign, "AuthorizedTradingRequired");

    await expect(buyAuthorized(campaign, owner, alice)).to.emit(campaign, "TokensPurchased");
    expect(await token.balanceOf(await alice.getAddress())).to.equal(TOKEN);
  });

  it("prevents signed route authorization replay", async () => {
    const { campaign, owner, alice } = await createProtectedCampaign();
    const quote = await campaign.quoteBuyExactTokens(TOKEN);
    const auth = await routeSignature(owner, campaign, alice, TRADE_AUTH_BUY_EXACT_TOKENS, TOKEN, quote);

    await expect(
      campaign.connect(alice).buyExactTokensAuthorized(TOKEN, quote, auth.routeProfile, auth.deadline, auth.signature, {
        value: quote,
      })
    ).to.emit(campaign, "TokensPurchased");

    await expect(
      campaign.connect(alice).buyExactTokensAuthorized(TOKEN, quote, auth.routeProfile, auth.deadline, auth.signature, {
        value: quote,
      })
    ).to.be.revertedWithCustomError(campaign, "RouteAuthReplayed");
  });

  it("rejects signatures for the wrong campaign, chain, or route profile", async () => {
    const { campaign, factory, owner, alice, bob } = await createProtectedCampaign();
    await factory.connect(bob).createCampaign(req({ name: "OtherToken", symbol: "OTHR" }) as any);
    const otherInfo = await factory.getCampaign(1n);
    const quote = await campaign.quoteBuyExactTokens(TOKEN);
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 600 + routeDeadlineSalt++);
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const aliceAddress = await alice.getAddress();
    const campaignAddress = await campaign.getAddress();

    const wrongCampaignSignature = await signRouteAuthorization(
      owner,
      otherInfo.campaign,
      aliceAddress,
      ROUTE_PROFILE,
      TRADE_AUTH_BUY_EXACT_TOKENS,
      TOKEN,
      quote,
      chainId,
      deadline
    );
    await expect(
      campaign.connect(alice).buyExactTokensAuthorized(TOKEN, quote, ROUTE_PROFILE, deadline, wrongCampaignSignature, {
        value: quote,
      })
    ).to.be.revertedWithCustomError(campaign, "BadRouteAuth");

    const wrongChainSignature = await signRouteAuthorization(
      owner,
      campaignAddress,
      aliceAddress,
      ROUTE_PROFILE,
      TRADE_AUTH_BUY_EXACT_TOKENS,
      TOKEN,
      quote,
      chainId + 1n,
      deadline
    );
    await expect(
      campaign.connect(alice).buyExactTokensAuthorized(TOKEN, quote, ROUTE_PROFILE, deadline, wrongChainSignature, {
        value: quote,
      })
    ).to.be.revertedWithCustomError(campaign, "BadRouteAuth");

    const wrongProfileSignature = await signRouteAuthorization(
      owner,
      campaignAddress,
      aliceAddress,
      0,
      TRADE_AUTH_BUY_EXACT_TOKENS,
      TOKEN,
      quote,
      chainId,
      deadline
    );
    await expect(
      campaign.connect(alice).buyExactTokensAuthorized(TOKEN, quote, ROUTE_PROFILE, deadline, wrongProfileSignature, {
        value: quote,
      })
    ).to.be.revertedWithCustomError(campaign, "BadRouteAuth");
  });

  it("keeps sells route-authorized during the anti-sniper window", async () => {
    const { campaign, token, owner, alice } = await createProtectedCampaign();
    await buyAuthorized(campaign, owner, alice);
    await token.connect(alice).approve(await campaign.getAddress(), TOKEN);

    await expect(campaign.connect(alice).sellExactTokens(TOKEN, 0n)).to.be.revertedWithCustomError(
      campaign,
      "AuthorizedTradingRequired"
    );

    const auth = await routeSignature(owner, campaign, alice, TRADE_AUTH_SELL_EXACT_TOKENS, TOKEN, 0n);
    await expect(
      campaign.connect(alice).sellExactTokensAuthorized(TOKEN, 0n, auth.routeProfile, auth.deadline, auth.signature)
    ).to.emit(campaign, "TokensSold");
  });

  it("the fee window closes by time, the launch config cannot be changed after campaigns exist, and trading stays route-authorized", async () => {
    const { campaign, factory, owner, alice } = await createProtectedCampaign();

    await expect(
      factory.connect(owner).setConfig({
        totalSupply: ethers.parseEther("1000"),
        curveBps: 5000,
        liquidityTokenBps: 4000,
        basePrice: 10n ** 12n,
        priceSlope: 10n ** 13n,
        graduationTarget: ethers.parseEther("1"),
      })
    ).to.be.revertedWithCustomError(factory, "FactoryLocked");
    await expect(factory.connect(owner).setProtocolFee(100n)).to.be.revertedWithCustomError(factory, "FactoryLocked");

    const launchAt = Number(await campaign.launchAt());
    await ethers.provider.send("evm_setNextBlockTimestamp", [launchAt + 60]);
    await ethers.provider.send("evm_mine", []);
    expect(await campaign.currentTradeFeeBps()).to.equal(await campaign.protocolFeeBps());

    // E7(b): the unsigned entry points stay closed after the window; only a signed route trades.
    await expect(
      campaign.connect(alice).buyExactBnb(0n, { value: ethers.parseEther("0.01") })
    ).to.be.revertedWithCustomError(campaign, "AuthorizedTradingRequired");
    await expect(buyAuthorized(campaign, owner, alice)).to.emit(campaign, "TokensPurchased");
  });
});
