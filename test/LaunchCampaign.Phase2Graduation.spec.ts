import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployCoreFixture } from "./fixtures/core";

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function makeGraduationEligibleByOracle(campaign: any, priceFeed: any) {
  const now = await latestTimestamp();
  await priceFeed.setRoundData(2n, ethers.parseUnits("1000000", 8), now, now, 2n);
  expect(await campaign.netRaisedWei()).to.be.gte(await campaign.graduationNativeTarget());
}

async function deployEarlyGraduationCampaign() {
  const fx = await deployCoreFixture();
  const { owner, creator, alice, factory } = fx;

  await factory.connect(owner).setConfig({
    totalSupply: ethers.parseEther("1000"),
    curveBps: 5000,
    liquidityTokenBps: 4000,
    basePrice: ethers.parseEther("0.025"),
    priceSlope: 10n ** 9n,
    graduationTarget: ethers.parseEther("10"),
    firstBuyTokens: 0n,
    firstBuyMaxCost: 0n,
    feeChoice: 1,
    feeCreatorPct: 0,
    liquidityBps: 8000,
  });

  await factory.connect(creator).createCampaign({
    name: "Early Grad",
    symbol: "EGR",
    logoURI: "ipfs://early-grad",
    xAccount: "",
    website: "",
    extraLink: "",
    graduationTarget: 0n,
    firstBuyTokens: 0n,
    firstBuyMaxCost: 0n,
    feeChoice: 1,
    feeCreatorPct: 0,
  } as any);

  const info = await factory.getCampaign(0n);
  const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
  const token = await ethers.getContractAt("LaunchToken", info.token);

  // Past the C2 anti-sniper window so the buy pays the flat 2% fee.
  await time.increase(61);
  const buyAmount = ethers.parseEther("1");
  const buyQuote = await campaign.quoteBuyExactTokens(buyAmount);
  await campaign.connect(alice).buyExactTokens(buyAmount, buyQuote, { value: buyQuote });
  await makeGraduationEligibleByOracle(campaign, fx.priceFeed);

  return { ...fx, campaign, token, buyAmount };
}

describe("LaunchCampaign Phase 2 graduation guardrails", function () {
  // EVM launch generation (C5): the pool is opened by the native graduation adapter, and the campaign checks the
  // adapter's reported start price against the curve's last price P (band: 50 bps). DexPriceDrift from the old
  // router path became StartPriceOutOfBand; a rejected graduation leaves the campaign Pending for a retry.
  it("rejects graduation when router liquidity opens outside the curve price tolerance", async () => {
    const { campaign, alice, graduationAdapter } = await deployEarlyGraduationCampaign();

    // start price 0.51% below P: always refused
    await graduationAdapter.setBehaviour(false, false, 0, 0, 0, 51, true);
    await expect(campaign.connect(alice).graduate()).to.be.revertedWithCustomError(campaign, "StartPriceOutOfBand");
    // start price 0.51% above P with MEME left in the budget: refused
    await graduationAdapter.setBehaviour(false, false, 0, 0, 0, 51, false);
    await expect(campaign.connect(alice).graduate()).to.be.revertedWithCustomError(campaign, "StartPriceOutOfBand");
    expect(await campaign.launched()).to.eq(false);

    // inside the band (exactly 50 bps below P) it graduates
    await graduationAdapter.setBehaviour(false, false, 0, 0, 0, 50, true);
    await expect(campaign.connect(alice).graduate()).to.emit(campaign, "Graduated");
    expect(await campaign.launched()).to.eq(true);
  });

  // EVM launch generation (C5): one budget (unsold curve + liquidity allocation), one burn. Everything the pool
  // does not take is burned as burnedUnsoldTokens; burnedUnusedLpTokens is always 0.
  it("records separate unsold curve and unused LP burn lanes on early graduation", async () => {
    const { campaign, token, alice, buyAmount } = await deployEarlyGraduationCampaign();
    const budget = (await campaign.totalSupply()) - (await campaign.creatorReserve()) - buyAmount;

    await campaign.connect(alice).graduate();

    const state = await campaign.getGraduationState();
    const burnedUnsoldTokens = state[6];
    const burnedUnusedLpTokens = state[7];
    const postBurnTotalSupply = state[8];

    expect(await campaign.sold()).to.equal(buyAmount);
    expect(burnedUnsoldTokens).to.equal(budget - state[3]);
    expect(burnedUnsoldTokens).to.be.gt((await campaign.curveSupply()) - buyAmount); // unsold curve and unused LP allocation
    expect(burnedUnusedLpTokens).to.equal(0n);
    expect(await token.balanceOf(await campaign.getAddress())).to.equal(0n);
    expect(postBurnTotalSupply).to.equal(await token.totalSupply());
    expect(postBurnTotalSupply).to.equal((await campaign.totalSupply()) - burnedUnsoldTokens - burnedUnusedLpTokens);
  });

  it("emits the same graduation telemetry that is stored for indexers", async () => {
    const { campaign, alice } = await deployEarlyGraduationCampaign();

    const tx = await campaign.connect(alice).graduate();
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((log: any) => {
        try {
          return campaign.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed: any) => parsed?.name === "Graduated");

    // EVM launch generation: CampaignFinalized was replaced by Graduated (C5).
    expect(event).to.not.equal(undefined);

    const state = await campaign.getGraduationState();
    const raise: bigint = state[9];
    const protocolShare = (raise * 220n) / 10000n;
    const creatorShare = (raise * 1980n) / 10000n;
    expect(event!.args.pool).to.equal(state[0]);
    expect(event!.args.curvePrice).to.equal(state[1]);
    expect(event!.args.startPrice).to.equal(state[2]);
    expect(event!.args.memeUsed).to.equal(state[3]);
    expect(event!.args.poolNative).to.equal(state[4]);
    expect(event!.args.memeBurned).to.equal(state[6]);
    expect(event!.args.raise).to.equal(raise);
    expect(event!.args.protocolShare).to.equal(protocolShare);
    expect(event!.args.creatorShare).to.equal(creatorShare);
    expect(event!.args.poolNative).to.equal(raise - protocolShare - creatorShare);
    expect(event!.args.repaired).to.equal(false);
    expect(state[5]).to.be.gt(0n); // LP liquidity stored
    expect(state[7]).to.equal(0n);
    expect(state[8]).to.equal((await campaign.totalSupply()) - state[6]);
    // overshoot = raise above the native target at Pending time (the oracle has not moved since)
    expect(state[10]).to.equal(raise - (await campaign.graduationNativeTarget()));
  });

  it("permanently locks the minted Topaz LP in the factory locker", async () => {
    const { owner, campaign, alice, creator, factory, permanentLpLocker } = await deployEarlyGraduationCampaign();

    const tx = await campaign.connect(alice).graduate();
    const receipt = await tx.wait();

    const state = await campaign.getGraduationState();
    const pairAddress = state[0];
    const lpMinted = state[5];
    const pair = await ethers.getContractAt("MockTopazPool", pairAddress);
    const lockerAddress = await permanentLpLocker.getAddress();
    const factoryGraduated = receipt!.logs
      .map((log: any) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed: any) => parsed?.name === "CampaignGraduated");

    expect(pairAddress).to.not.equal(ethers.ZeroAddress);
    expect(lpMinted).to.be.gt(0n);
    expect(factoryGraduated).to.not.equal(undefined);
    expect(factoryGraduated!.args.campaign).to.equal(await campaign.getAddress());
    expect(factoryGraduated!.args.creator).to.equal(await creator.getAddress());
    expect(factoryGraduated!.args.lpToken).to.equal(pairAddress);
    expect(factoryGraduated!.args.locker).to.equal(lockerAddress);
    expect(await permanentLpLocker.registeredLpToken(pairAddress)).to.equal(true);
    expect(await permanentLpLocker.lockedBalance(pairAddress)).to.equal(lpMinted);
    expect(await permanentLpLocker.lockedByDepositor(pairAddress, lockerAddress)).to.equal(lpMinted);
    expect(await pair.balanceOf(lockerAddress)).to.equal(lpMinted);
    expect(await pair.balanceOf(await owner.getAddress())).to.equal(0n);
    expect(await pair.balanceOf(await creator.getAddress())).to.equal(0n);
    expect(await pair.balanceOf(await campaign.getAddress())).to.equal(0n);
  });
});
