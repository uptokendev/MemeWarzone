import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { quoteBuyExactTokens, quoteSellExactTokens } from "./helpers/math";
import { getBalance } from "./helpers/balances";
import { deployLaunchFactory } from "./helpers/deployFactory";
import { deployConfiguredTreasuryRouterV3 } from "./helpers/deployRouting";

const TRADE_AUTH_BUY_EXACT_TOKENS = 0;

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function deployPhase1RoutingFixture() {
  const [owner, creator, alice, bob] = await ethers.getSigners();

  const TopazFactory = await ethers.getContractFactory("MockTopazFactory");
  const topazFactory = await TopazFactory.deploy();

  const DexRouter = await ethers.getContractFactory("MockRouter");
  const dexRouter = await DexRouter.deploy(await topazFactory.getAddress(), await owner.getAddress());

  // V3, because LaunchFactory points feeRecipient and leagueReceiver at this
  // router and stamps strictFeeRouting: true, so the campaign calls routeTrade /
  // routeFinalize. V1 has neither and reverts with no reason.
  const { treasuryRouter, leagueVault, monthlyVault, creatorVault, recruiterVault, protocolVault, communityVault } =
    await deployConfiguredTreasuryRouterV3(await owner.getAddress());

  const { factory, priceFeed } = await deployLaunchFactory(await dexRouter.getAddress(), await treasuryRouter.getAddress());
  await factory.connect(owner).setRequireRouteAuthorization(false);
  await factory.connect(owner).setRequireAuthorizedTrading(false);
  await factory.connect(owner).setRouteAuthority(await owner.getAddress());
  await factory.connect(owner).setConfig({
    totalSupply: ethers.parseEther("1000"),
    curveBps: 5000,
    liquidityTokenBps: 4000,
    basePrice: ethers.parseEther("0.005"),
    priceSlope: 10n ** 9n,
    graduationTarget: ethers.parseEther("2"),
    liquidityBps: 8000,
  });
  await factory.connect(owner).enableLive();

  return {
    owner,
    creator,
    alice,
    bob,
    dexRouter,
    leagueVault,
    monthlyVault,
    creatorVault,
    recruiterVault,
    protocolVault,
    treasuryRouter,
    communityVault,
    factory,
    priceFeed,
  };
}

async function signTradeRouteAuthorization(params: {
  signer: any;
  campaignAddress: string;
  actor: string;
  routeProfile: number;
  action: number;
  amount: bigint;
  limit: bigint;
  deadline: bigint;
  chainId: bigint;
}) {
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "uint256", "address", "address", "uint8", "uint8", "uint256", "uint256", "uint64"],
      [
        "MWZ_ROUTE_TRADE_AUTH",
        params.chainId,
        params.campaignAddress,
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

async function createCampaignViaPhase1RouterFixture(tradeRouteProfile = 1, finalizeRouteProfile = 1) {
  const fx = await deployPhase1RoutingFixture();
  await fx.factory.connect(fx.owner).setRouteProfiles(tradeRouteProfile, finalizeRouteProfile);
  const req = {
    name: "Phase1Token",
    symbol: "P1T",
    logoURI: "ipfs://phase1",
    xAccount: "phase1",
    website: "https://memewar.zone",
    extraLink: "https://docs.memewar.zone",
    basePrice: 0n,
    priceSlope: 0n,
    graduationTarget: 0n,
    lpReceiver: ethers.ZeroAddress,
    initialBuyBnbWei: 0n,
  };

  await fx.factory.connect(fx.creator).createCampaign(req as any);
  const info = await fx.factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", await campaign.token());

  return { ...fx, req, info, campaign, token, tradeRouteProfile, finalizeRouteProfile };
}

async function createLinkedCampaignViaPhase1RouterFixture() {
  return createCampaignViaPhase1RouterFixture(0, 0);
}

async function createOgCampaignViaPhase1RouterFixture() {
  return createCampaignViaPhase1RouterFixture(2, 2);
}

async function makeGraduationEligibleByOracle(campaign: any, priceFeed: any) {
  const now = await latestTimestamp();
  await priceFeed.setRoundData(2n, ethers.parseUnits("1000", 8), now, now, 2n);
  expect(await campaign.netRaisedWei()).to.be.gte(await campaign.graduationNativeTarget());
}

describe("LaunchCampaign Phase 1 router integration", function () {
  it("routes buy fees through TreasuryRouter using StandardUnlinked trade splits", async () => {
    const { campaign, token, alice, treasuryRouter, leagueVault, monthlyVault, creatorVault, recruiterVault, protocolVault, communityVault } =
      await loadFixture(createCampaignViaPhase1RouterFixture);

    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();
    const feeBps = await campaign.protocolFeeBps();
    const amountOut = ethers.parseEther("10");
    const sold0 = await campaign.sold();
    const { costNoFee, fee, total } = quoteBuyExactTokens(
      BigInt(sold0),
      BigInt(amountOut),
      BigInt(base),
      BigInt(slope),
      BigInt(feeBps)
    );

    const expected = await treasuryRouter.previewRoute(fee, 0, 1);
    // TreasuryRouterV3 splits league into weekly and monthly, so reading the
    // weekly vault alone sees 30% of it. Capture both, and the creator share.
    const leagueBefore =
      (await getBalance(await leagueVault.getAddress())) + (await getBalance(await monthlyVault.getAddress()));
    const creatorBefore = await getBalance(await creatorVault.getAddress());
    const recruiterBefore = await getBalance(await recruiterVault.getAddress());
    const protocolBefore = await getBalance(await protocolVault.getAddress());
    const airdropBefore = await communityVault.warzoneAirdropBalance();
    const squadBefore = await communityVault.squadPoolBalance();
    const campaignBefore = await getBalance(await campaign.getAddress());

    await campaign.connect(alice).buyExactTokens(amountOut, total, { value: total });

    expect(await token.balanceOf(await alice.getAddress())).to.equal(amountOut);
    expect(
      (await getBalance(await leagueVault.getAddress())) +
        (await getBalance(await monthlyVault.getAddress())) -
        leagueBefore,
    ).to.equal(expected.league);
    expect((await getBalance(await creatorVault.getAddress())) - creatorBefore).to.equal(expected.creator);
    expect((await getBalance(await recruiterVault.getAddress())) - recruiterBefore).to.equal(expected.recruiter);
    expect((await getBalance(await protocolVault.getAddress())) - protocolBefore).to.equal(expected.protocol);
    expect((await communityVault.warzoneAirdropBalance()) - airdropBefore).to.equal(expected.airdrop);
    expect((await communityVault.squadPoolBalance()) - squadBefore).to.equal(expected.squad);
    expect((await getBalance(await campaign.getAddress())) - campaignBefore).to.equal(costNoFee);
  });

  it("routes sell fees through TreasuryRouter using StandardUnlinked trade splits", async () => {
    const { campaign, token, alice, treasuryRouter, leagueVault, monthlyVault, creatorVault, recruiterVault, protocolVault, communityVault } =
      await loadFixture(createCampaignViaPhase1RouterFixture);

    const amountOut = ethers.parseEther("10");
    const buyTotal = await campaign.quoteBuyExactTokens(amountOut);
    await campaign.connect(alice).buyExactTokens(amountOut, buyTotal, { value: buyTotal });

    const amountIn = ethers.parseEther("4");
    await token.connect(alice).approve(await campaign.getAddress(), amountIn);

    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();
    const feeBps = await campaign.protocolFeeBps();
    const soldBefore = await campaign.sold();
    const { gross, fee, payout } = quoteSellExactTokens(
      BigInt(soldBefore),
      BigInt(amountIn),
      BigInt(base),
      BigInt(slope),
      BigInt(feeBps)
    );

    const expected = await treasuryRouter.previewRoute(fee, 0, 1);
    // TreasuryRouterV3 splits league into weekly and monthly, so reading the
    // weekly vault alone sees 30% of it. Capture both, and the creator share.
    const leagueBefore =
      (await getBalance(await leagueVault.getAddress())) + (await getBalance(await monthlyVault.getAddress()));
    const creatorBefore = await getBalance(await creatorVault.getAddress());
    const recruiterBefore = await getBalance(await recruiterVault.getAddress());
    const protocolBefore = await getBalance(await protocolVault.getAddress());
    const airdropBefore = await communityVault.warzoneAirdropBalance();
    const squadBefore = await communityVault.squadPoolBalance();
    const campaignBefore = await getBalance(await campaign.getAddress());

    await campaign.connect(alice).sellExactTokens(amountIn, payout);

    expect(
      (await getBalance(await leagueVault.getAddress())) +
        (await getBalance(await monthlyVault.getAddress())) -
        leagueBefore,
    ).to.equal(expected.league);
    expect((await getBalance(await creatorVault.getAddress())) - creatorBefore).to.equal(expected.creator);
    expect((await getBalance(await recruiterVault.getAddress())) - recruiterBefore).to.equal(expected.recruiter);
    expect((await getBalance(await protocolVault.getAddress())) - protocolBefore).to.equal(expected.protocol);
    expect((await communityVault.warzoneAirdropBalance()) - airdropBefore).to.equal(expected.airdrop);
    expect((await communityVault.squadPoolBalance()) - squadBefore).to.equal(expected.squad);
    expect(campaignBefore - (await getBalance(await campaign.getAddress()))).to.equal(gross);
  });

  it("routes finalize fees through TreasuryRouter using StandardUnlinked finalize splits without breaking launch", async () => {
    const { campaign, alice, treasuryRouter, leagueVault, monthlyVault, creatorVault, recruiterVault, protocolVault, communityVault, priceFeed } =
      await loadFixture(createCampaignViaPhase1RouterFixture);

    const oneToken = ethers.parseUnits("1", 18);
    const quote = await campaign.quoteBuyExactTokens(oneToken);
    await campaign.connect(alice).buyExactTokens(oneToken, quote, { value: quote });
    await makeGraduationEligibleByOracle(campaign, priceFeed);

    const graduationPrincipal = await campaign.netRaisedWei();
    const protocolFeeBps = await campaign.protocolFeeBps();
    const protocolFee = (graduationPrincipal * protocolFeeBps) / 10_000n;
    const expected = await treasuryRouter.previewRoute(protocolFee, 1, 1);

    // TreasuryRouterV3 splits league into weekly and monthly, so reading the
    // weekly vault alone sees 30% of it. Capture both, and the creator share.
    const leagueBefore =
      (await getBalance(await leagueVault.getAddress())) + (await getBalance(await monthlyVault.getAddress()));
    const creatorBefore = await getBalance(await creatorVault.getAddress());
    const recruiterBefore = await getBalance(await recruiterVault.getAddress());
    const protocolBefore = await getBalance(await protocolVault.getAddress());
    const airdropBefore = await communityVault.warzoneAirdropBalance();
    const squadBefore = await communityVault.squadPoolBalance();

    const tx = await campaign.connect(alice).graduateIfEligible(0, 0);
    const rc = await tx.wait();

    expect(await campaign.launched()).to.equal(true);
    expect(
      (await getBalance(await leagueVault.getAddress())) +
        (await getBalance(await monthlyVault.getAddress())) -
        leagueBefore,
    ).to.equal(expected.league);
    expect((await getBalance(await creatorVault.getAddress())) - creatorBefore).to.equal(expected.creator);
    expect((await getBalance(await recruiterVault.getAddress())) - recruiterBefore).to.equal(expected.recruiter);
    expect((await getBalance(await protocolVault.getAddress())) - protocolBefore).to.equal(expected.protocol);
    expect((await communityVault.warzoneAirdropBalance()) - airdropBefore).to.equal(expected.airdrop);
    expect((await communityVault.squadPoolBalance()) - squadBefore).to.equal(expected.squad);

    const event = rc!.logs
      .map((log: any) => {
        try {
          return campaign.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed: any) => parsed?.name === "CampaignFinalized");

    expect(event).to.not.equal(undefined);
    expect(event!.args.protocolFee).to.equal(protocolFee);
  });

  it("routes linked trade + finalize profiles end to end when factory is configured for StandardLinked", async () => {
    const { campaign, alice, treasuryRouter, recruiterVault, protocolVault, communityVault, priceFeed } =
      await loadFixture(createLinkedCampaignViaPhase1RouterFixture);

    const amountOut = ethers.parseEther("10");
    const buyTotal = await campaign.quoteBuyExactTokens(amountOut);
    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();
    const feeBps = await campaign.protocolFeeBps();
    const sold0 = await campaign.sold();
    const { fee } = quoteBuyExactTokens(
      BigInt(sold0),
      BigInt(amountOut),
      BigInt(base),
      BigInt(slope),
      BigInt(feeBps)
    );
    const expectedTrade = await treasuryRouter.previewRoute(fee, 0, 0);

    const recruiterBeforeTrade = await getBalance(await recruiterVault.getAddress());
    const protocolBeforeTrade = await getBalance(await protocolVault.getAddress());
    const squadBeforeTrade = await communityVault.squadPoolBalance();

    await campaign.connect(alice).buyExactTokens(amountOut, buyTotal, { value: buyTotal });

    expect((await getBalance(await recruiterVault.getAddress())) - recruiterBeforeTrade).to.equal(expectedTrade.recruiter);
    expect((await getBalance(await protocolVault.getAddress())) - protocolBeforeTrade).to.equal(expectedTrade.protocol);
    expect((await communityVault.squadPoolBalance()) - squadBeforeTrade).to.equal(expectedTrade.squad);

    await makeGraduationEligibleByOracle(campaign, priceFeed);

    const graduationPrincipal = await campaign.netRaisedWei();
    const protocolFee = (graduationPrincipal * feeBps) / 10_000n;
    const expectedFinalize = await treasuryRouter.previewRoute(protocolFee, 1, 0);

    const recruiterBeforeFinalize = await getBalance(await recruiterVault.getAddress());
    const protocolBeforeFinalize = await getBalance(await protocolVault.getAddress());
    const squadBeforeFinalize = await communityVault.squadPoolBalance();

    await campaign.connect(alice).graduateIfEligible(0, 0);

    expect((await getBalance(await recruiterVault.getAddress())) - recruiterBeforeFinalize).to.equal(expectedFinalize.recruiter);
    expect((await getBalance(await protocolVault.getAddress())) - protocolBeforeFinalize).to.equal(expectedFinalize.protocol);
    expect((await communityVault.squadPoolBalance()) - squadBeforeFinalize).to.equal(expectedFinalize.squad);
  });

  it("routes OG-linked trade + finalize profiles end to end when factory is configured for OgLinked", async () => {
    const { campaign, alice, treasuryRouter, recruiterVault, protocolVault, communityVault, priceFeed } =
      await loadFixture(createOgCampaignViaPhase1RouterFixture);

    const amountOut = ethers.parseEther("10");
    const buyTotal = await campaign.quoteBuyExactTokens(amountOut);
    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();
    const feeBps = await campaign.protocolFeeBps();
    const sold0 = await campaign.sold();
    const { fee } = quoteBuyExactTokens(
      BigInt(sold0),
      BigInt(amountOut),
      BigInt(base),
      BigInt(slope),
      BigInt(feeBps)
    );
    const expectedTrade = await treasuryRouter.previewRoute(fee, 0, 2);

    const recruiterBeforeTrade = await getBalance(await recruiterVault.getAddress());
    const protocolBeforeTrade = await getBalance(await protocolVault.getAddress());
    const squadBeforeTrade = await communityVault.squadPoolBalance();

    await campaign.connect(alice).buyExactTokens(amountOut, buyTotal, { value: buyTotal });

    expect((await getBalance(await recruiterVault.getAddress())) - recruiterBeforeTrade).to.equal(expectedTrade.recruiter);
    expect((await getBalance(await protocolVault.getAddress())) - protocolBeforeTrade).to.equal(expectedTrade.protocol);
    expect((await communityVault.squadPoolBalance()) - squadBeforeTrade).to.equal(expectedTrade.squad);

    await makeGraduationEligibleByOracle(campaign, priceFeed);

    const graduationPrincipal = await campaign.netRaisedWei();
    const protocolFee = (graduationPrincipal * feeBps) / 10_000n;
    const expectedFinalize = await treasuryRouter.previewRoute(protocolFee, 1, 2);

    const recruiterBeforeFinalize = await getBalance(await recruiterVault.getAddress());
    const protocolBeforeFinalize = await getBalance(await protocolVault.getAddress());
    const squadBeforeFinalize = await communityVault.squadPoolBalance();

    await campaign.connect(alice).graduateIfEligible(0, 0);

    expect((await getBalance(await recruiterVault.getAddress())) - recruiterBeforeFinalize).to.equal(expectedFinalize.recruiter);
    expect((await getBalance(await protocolVault.getAddress())) - protocolBeforeFinalize).to.equal(expectedFinalize.protocol);
    expect((await communityVault.squadPoolBalance()) - squadBeforeFinalize).to.equal(expectedFinalize.squad);
  });

  it("routes authorized trade fees per wallet without changing the campaign default profile", async () => {
    const { campaign, alice, owner, treasuryRouter, recruiterVault, protocolVault, communityVault } =
      await loadFixture(createCampaignViaPhase1RouterFixture);

    const amountOut = ethers.parseEther("10");
    const buyTotal = await campaign.quoteBuyExactTokens(amountOut);
    const base = await campaign.basePrice();
    const slope = await campaign.priceSlope();
    const feeBps = await campaign.protocolFeeBps();
    const sold0 = await campaign.sold();
    const { fee } = quoteBuyExactTokens(
      BigInt(sold0),
      BigInt(amountOut),
      BigInt(base),
      BigInt(slope),
      BigInt(feeBps)
    );

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 600);
    const signature = await signTradeRouteAuthorization({
      signer: owner,
      campaignAddress: await campaign.getAddress(),
      actor: await alice.getAddress(),
      routeProfile: 0,
      action: TRADE_AUTH_BUY_EXACT_TOKENS,
      amount: amountOut,
      limit: buyTotal,
      deadline,
      chainId,
    });
    const expectedTrade = await treasuryRouter.previewRoute(fee, 0, 0);

    const recruiterBeforeTrade = await getBalance(await recruiterVault.getAddress());
    const protocolBeforeTrade = await getBalance(await protocolVault.getAddress());
    const squadBeforeTrade = await communityVault.squadPoolBalance();

    await campaign.connect(alice).buyExactTokensAuthorized(amountOut, buyTotal, 0, deadline, signature, { value: buyTotal });

    expect((await getBalance(await recruiterVault.getAddress())) - recruiterBeforeTrade).to.equal(expectedTrade.recruiter);
    expect((await getBalance(await protocolVault.getAddress())) - protocolBeforeTrade).to.equal(expectedTrade.protocol);
    expect((await communityVault.squadPoolBalance()) - squadBeforeTrade).to.equal(expectedTrade.squad);
    expect(await campaign.tradeRouteProfile()).to.equal(1n);
  });
});
