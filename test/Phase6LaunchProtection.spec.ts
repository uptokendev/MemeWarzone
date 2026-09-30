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
  basePrice: ethers.parseEther("0.001"),
  priceSlope: 1n,
  graduationTarget: ethers.parseEther("100"),
  firstBuyTokens: 0n,
  firstBuyMaxCost: 0n,
  feeChoice: 1,
  feeCreatorPct: 0,
  lpReceiver: ethers.ZeroAddress,
  ...overrides,
});

async function createProtectedCampaign(overrides: Record<string, unknown> = {}) {
  const fixture = await deployCoreFixture();
  const { factory, owner, creator } = fixture;

  await factory.connect(owner).setRouteAuthority(await owner.getAddress());
  await factory.connect(owner).setConfig({
    totalSupply: ethers.parseEther("1000"),
    curveBps: 5000,
    liquidityTokenBps: 4000,
    basePrice: ethers.parseEther("0.001"),
    priceSlope: 1n,
    graduationTarget: ethers.parseEther("100"),
    firstBuyTokens: 0n,
    firstBuyMaxCost: 0n,
    feeChoice: 1,
    feeCreatorPct: 0,
    liquidityBps: 8000,
  });
  await factory
    .connect(owner)
    .setLaunchProtectionConfig(4n, ethers.parseEther("0.0015"), ethers.parseEther("0.0025"));
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
  it("blocks direct buys during the protected blocks and allows signed route buys", async () => {
    const { campaign, owner, alice } = await createProtectedCampaign();
    const currentBlock = await ethers.provider.getBlockNumber();

    expect(await campaign.launchProtectionEndBlock()).to.be.gt(currentBlock);
    await expect(
      campaign.connect(alice).buyExactBnb(0n, { value: ethers.parseEther("0.01") })
    ).to.be.revertedWithCustomError(campaign, "AuthorizedTradingRequired");

    await expect(buyAuthorized(campaign, owner, alice)).to.emit(campaign, "TokensPurchased");
    expect(await campaign.protectedBuyWei(await alice.getAddress())).to.be.gt(0n);
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

  it("enforces per-buy and cumulative wallet caps so split buys cannot bypass the window", async () => {
    const { campaign, owner, alice, bob } = await createProtectedCampaign();
    const oversizedAmount = 2n * TOKEN;
    const oversizedQuote = await campaign.quoteBuyExactTokens(oversizedAmount);
    const oversizedAuth = await routeSignature(
      owner,
      campaign,
      bob,
      TRADE_AUTH_BUY_EXACT_TOKENS,
      oversizedAmount,
      oversizedQuote
    );

    await expect(
      campaign.connect(bob).buyExactTokensAuthorized(
        oversizedAmount,
        oversizedQuote,
        oversizedAuth.routeProfile,
        oversizedAuth.deadline,
        oversizedAuth.signature,
        { value: oversizedQuote }
      )
    ).to.be.revertedWithCustomError(campaign, "LaunchProtectionBuyLimit");

    await buyAuthorized(campaign, owner, alice);
    await buyAuthorized(campaign, owner, alice);
    await expect(buyAuthorized(campaign, owner, alice)).to.be.revertedWithCustomError(
      campaign,
      "LaunchProtectionWalletLimit"
    );
  });

  it("keeps sells route-authorized during the protected window", async () => {
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

  it("expires at the block boundary and cannot be restarted after campaigns exist", async () => {
    const { campaign, factory, owner, alice } = await createProtectedCampaign();

    await expect(
      factory.connect(owner).setLaunchProtectionConfig(8n, ethers.parseEther("0.01"), ethers.parseEther("0.02"))
    ).to.be.revertedWithCustomError(factory, "FactoryLocked");

    for (let i = 0; i < 5; i++) {
      await ethers.provider.send("evm_mine", []);
    }

    await expect(
      campaign.connect(alice).buyExactBnb(0n, { value: ethers.parseEther("0.01") })
    ).to.emit(campaign, "TokensPurchased");
  });
});
