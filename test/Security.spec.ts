import { expect } from "chai";
import { ethers } from "hardhat";
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

import { deployCoreFixture } from "./fixtures/core";
import { deployEvmGen, createCoin, buyTokens, sellTokens, mineAt, E } from "./fixtures/evmgenCore";

// Direct trades below land after the C2 anti-sniper window (flat protocolFeeBps).
async function pastSniperWindow(campaign: any) {
  await mineAt(Number(await campaign.launchAt()) + 61);
}

const req = (overrides: Record<string, unknown> = {}) => ({
  name: "T",
  symbol: "T",
  logoURI: "ipfs://logo",
  xAccount: "",
  website: "",
  extraLink: "",
  basePrice: 0n,
  priceSlope: 0n,
  graduationTarget: 0n,
  firstBuyTokens: 0n,
  firstBuyMaxCost: 0n,
  feeChoice: 1,
  feeCreatorPct: 0,
  lpReceiver: ethers.ZeroAddress,
  ...overrides,
});

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block!.timestamp);
}

async function makeGraduationEligibleByOracle(campaign: any, priceFeed: any) {
  const now = await latestTimestamp();
  await priceFeed.setRoundData(2n, ethers.parseUnits("1000", 8), now, now, 2n);
  expect(await campaign.netRaisedWei()).to.be.gte(await campaign.graduationNativeTarget());
}

// TreasuryRouterV3 splits league into weekly and monthly and pays a creator
// share, so every destination has to be read or a correctly routed fee looks
// like a shortfall. See the same helper in LaunchCampaign.spec.ts.
async function captureRouteBalances(vaults: any) {
  return {
    league:
      (await ethers.provider.getBalance(await vaults.treasuryVault.getAddress())) +
      (await ethers.provider.getBalance(await vaults.monthlyLeagueReceiver.getAddress())),
    creator: await ethers.provider.getBalance(await vaults.creatorVault.getAddress()),
    recruiter: await ethers.provider.getBalance(await vaults.recruiterVault.getAddress()),
    airdrop: await vaults.communityVault.warzoneAirdropBalance(),
    squad: await vaults.communityVault.squadPoolBalance(),
    protocol: await ethers.provider.getBalance(await vaults.protocolVault.getAddress()),
  };
}

async function expectRouteBalanceDelta(before: any, vaults: any, expected: any) {
  const after = await captureRouteBalances(vaults);
  expect(after.league - before.league).to.eq(expected.league);
  expect(after.creator - before.creator).to.eq(expected.creator);
  expect(after.recruiter - before.recruiter).to.eq(expected.recruiter);
  expect(after.airdrop - before.airdrop).to.eq(expected.airdrop);
  expect(after.squad - before.squad).to.eq(expected.squad);
  expect(after.protocol - before.protocol).to.eq(expected.protocol);
}

describe("Security & invariants", function () {
  // C5: the crossing buy cannot leave the campaign tradable past its target. It flips the campaign
  // into Pending inside the same transaction (curve frozen, token still locked); graduate() is then
  // permissionless.
  it("auto-finalize cannot be skipped: crossing buy flips launched in same tx", async function () {
    const { owner, creator, alice, bob, factory } = await deployCoreFixture();

    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000,
      liquidityTokenBps: 4000,
      basePrice: ethers.parseEther("0.005"),
      priceSlope: 10n ** 9n,
      graduationTarget: ethers.parseEther("0.005"),
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: 1,
      feeCreatorPct: 0,
    });

    await factory.connect(creator).createCampaign(req({ lpReceiver: await alice.getAddress() }) as any);
    const count = await factory.campaignsCount();
    const info = await factory.getCampaign(count - 1n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const token = await ethers.getContractAt("LaunchToken", info.token);
    await pastSniperWindow(campaign);

    const buyValue = await campaign.quoteBuyExactTokens(ethers.parseUnits("1", 18));
    const buyTx = await campaign.connect(alice).buyExactBnb(0, { value: buyValue });
    const buyRc = await buyTx.wait();

    const pendingInTx = buyRc!.logs.some((l: any) => l.fragment?.name === "GraduationPending");
    expect(pendingInTx).to.equal(true);
    expect(await campaign.graduationPending()).to.equal(true);
    // nobody can keep trading the curve past the target
    await expect(campaign.connect(bob).buyExactBnb(0, { value: buyValue })).to.be.revertedWithCustomError(campaign, "GraduationIsPending");
    await expect(campaign.connect(alice).sellExactTokens(1n, 0n)).to.be.revertedWithCustomError(campaign, "GraduationIsPending");
    await expect(token.connect(alice).transfer(await bob.getAddress(), 1n)).to.be.reverted;

    await expect(campaign.connect(bob).graduate()).to.emit(campaign, "Graduated");
    expect(await campaign.launched()).to.equal(true);
  });

  // C5: the protocol's graduation share is a fixed 2.2% of the frozen raise (GRAD_PROTOCOL_BPS), routed
  // through routeFinalize with the campaign's finalize profile.
  it("finalize fee amounts: protocol share equals netRaisedWei * 220 / 10000 (C5 fixed 2.2%)", async function () {
    const {
      owner,
      creator,
      alice,
      factory,
      treasuryRouter,
      treasuryVault,
      recruiterVault,
      communityVault,
      protocolVault,
      monthlyLeagueReceiver,
      creatorVault,
      priceFeed,
    } = await deployCoreFixture();

    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000,
      liquidityTokenBps: 4000,
      basePrice: ethers.parseEther("0.005"),
      priceSlope: 10n ** 9n,
      graduationTarget: ethers.parseEther("2"),
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: 1,
      feeCreatorPct: 0,
    });
    await factory.connect(owner).setProtocolFee(200);

    await factory.connect(creator).createCampaign(req({ name: "F", symbol: "F" }) as any);
    const count = await factory.campaignsCount();
    const info = await factory.getCampaign(count - 1n);
    const campaignAddr = info.campaign;
    const campaign = await ethers.getContractAt("LaunchCampaign", campaignAddr);
    await pastSniperWindow(campaign);

    const oneToken = ethers.parseUnits("1", 18);
    const q = await campaign.quoteBuyExactTokens(oneToken);
    const qBuf = q + 1n;
    await campaign.connect(alice).buyExactTokens(oneToken, qBuf, { value: qBuf });
    await makeGraduationEligibleByOracle(campaign, priceFeed);

    const graduationPrincipal = await campaign.netRaisedWei();
    const expectedFee = (graduationPrincipal * 220n) / 10_000n;
    const expectedCreator = (graduationPrincipal * 1980n) / 10_000n;
    const routeVaults = { treasuryVault, monthlyLeagueReceiver, creatorVault, recruiterVault, communityVault, protocolVault };
    const routeBefore = await captureRouteBalances(routeVaults);

    const finTx = await campaign.connect(alice).graduate();
    const finRc = await finTx.wait();

    let finParsed: any = null;
    for (const log of finRc!.logs) {
      try {
        const p = campaign.interface.parseLog(log);
        if (p && p.name === "Graduated") {
          finParsed = p;
          break;
        }
      } catch {}
    }
    expect(finParsed).to.not.equal(null);
    expect(finParsed!.args.raise).to.equal(graduationPrincipal);
    expect(finParsed!.args.protocolShare).to.equal(expectedFee);
    expect(finParsed!.args.creatorShare).to.equal(expectedCreator);
    expect(await campaign.pendingProtocolGraduationFee()).to.equal(0n);

    const expectedRoute = await treasuryRouter.previewRoute(expectedFee, 1, await campaign.finalizeRouteProfile());
    await expectRouteBalanceDelta(routeBefore, routeVaults, expectedRoute);
  });

  // The mock graduation adapter (MockGraduationAdapterEvmGen) puts the MEME into the pool, keeps the
  // native itself and mints LP to the locker; it does not maintain pool reserves. So liquidity is
  // proven by balances: the pool holds exactly the MEME the campaign reports, the adapter received
  // exactly the pool native, and LP exists.
  it("DEX reserves correctness: LP deploy results in non-zero pair reserves when pair is registered", async function () {
    const { owner, creator, alice, factory, v2factory, router, graduationAdapter } = await deployCoreFixture();

    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 1000,
      liquidityTokenBps: 8000,
      basePrice: 10n ** 12n,
      priceSlope: 10n ** 9n,
      graduationTarget: 1n,
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: 1,
      feeCreatorPct: 0,
    });

    await factory.connect(creator).createCampaign(req({ name: "P", symbol: "P" }) as any);
    const count = await factory.campaignsCount();
    const info = await factory.getCampaign(count - 1n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const tokenAddr = await campaign.token();
    const token = await ethers.getContractAt("LaunchToken", tokenAddr);
    await pastSniperWindow(campaign);

    const Pool = await ethers.getContractFactory("MockTopazPool");
    const pool = await Pool.deploy();
    await v2factory.setPool(tokenAddr, await router.WETH(), false, await pool.getAddress());

    const curveSupply = await campaign.curveSupply();
    await campaign.connect(alice).buyExactTokens(curveSupply, ethers.MaxUint256, { value: ethers.parseEther("10") });
    await campaign.connect(alice).graduate();

    const state = await campaign.getGraduationState();
    expect(state[0]).to.equal(await pool.getAddress());
    expect(state.graduatedLiquidityTokens).to.be.gt(0n);
    expect(state.graduatedLiquidityBnb).to.be.gt(0n);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(state.graduatedLiquidityTokens);
    expect(await graduationAdapter.lastValue()).to.equal(state.graduatedLiquidityBnb);
    expect(await pool.totalSupply()).to.be.gt(0);
    expect(state.graduatedLiquidityLp).to.equal(await pool.totalSupply());
  });

  // The treasury router is fixed at factory construction (setCoreRouting is gone), so the probe is
  // a router that (mode 0) refuses the fee or (mode 1) re-enters the campaign from routeTrade.
  // Mode 0: strict routing reverts the whole trade, nothing moves. Mode 1: every trade entry point
  // is behind the reentrancy guard.
  it("reentrancy defense: a fee recipient that cannot route takes nothing and re-enters nothing", async function () {
    const env = await deployEvmGen();
    const { campaign, token } = await createCoin(env);
    await mineAt(Number(await campaign.launchAt()) + 61);
    const c = await campaign.getAddress();
    const amount = E(1_000_000);

    // mode 0: the router refuses routeTrade
    await env.evmRouter.setReverts(true, false);
    const soldBefore = await campaign.sold();
    const routerBefore = await ethers.provider.getBalance(await env.evmRouter.getAddress());
    await expect(buyTokens(env, campaign, env.alice, amount)).to.be.revertedWith("trade paused");
    expect(await campaign.sold()).to.eq(soldBefore);
    expect(await campaign.netRaisedWei()).to.eq(0n);
    expect(await token.balanceOf(env.alice.address)).to.eq(0n);
    expect(await ethers.provider.getBalance(c)).to.eq(0n);
    expect(await ethers.provider.getBalance(await env.evmRouter.getAddress())).to.eq(routerBefore);
    expect(await env.evmRouter.tradeCalls()).to.eq(0n);
    await env.evmRouter.setReverts(false, false);

    // mode 1: the router re-enters buy / sell / buyExactBnb from inside routeTrade
    const guard = campaign.interface.getError("ReentrancyGuardReentrantCall")!.selector;
    const reentries = [
      campaign.interface.encodeFunctionData("buyExactTokens", [1n, ethers.MaxUint256]),
      campaign.interface.encodeFunctionData("buyExactBnb", [0n]),
      campaign.interface.encodeFunctionData("sellExactTokens", [1n, 0n]),
    ];
    for (const data of reentries) {
      await env.evmRouter.setReenter(data);
      await buyTokens(env, campaign, env.alice, amount);
      expect(await env.evmRouter.reenterAttempted()).to.eq(true);
      expect(await env.evmRouter.reenterSucceeded()).to.eq(false);
      expect(await env.evmRouter.reenterRevertSelector()).to.eq(guard);
    }
    await sellTokens(env, campaign, token, env.alice, amount);
    expect(await env.evmRouter.reenterSucceeded()).to.eq(false);
    expect(await env.evmRouter.reenterRevertSelector()).to.eq(guard);
    // accounting saw exactly the outer trades
    expect(await token.balanceOf(env.alice.address)).to.eq(amount * BigInt(reentries.length) - amount);
    expect(await campaign.sold()).to.eq(amount * BigInt(reentries.length - 1));
  });

  // The request carries no LP receiver any more (lpReceiver is gone from CampaignRequest and the
  // campaign); an extra field in the request is ignored. LP goes to the factory's locker, which the
  // factory registers at graduation with the whole locked LP balance.
  it("LP lock cannot be bypassed: factory ignores user lpReceiver and liquidity LP is minted to locker", async function () {
    const { owner, creator, alice, factory, permanentLpLocker } = await deployCoreFixture();

    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 1000,
      liquidityTokenBps: 8000,
      basePrice: 10n ** 12n,
      priceSlope: 10n ** 9n,
      graduationTarget: 1n,
      firstBuyTokens: 0n,
      firstBuyMaxCost: 0n,
      feeChoice: 1,
      feeCreatorPct: 0,
    });

    await factory.connect(creator).createCampaign(req({ name: "B", symbol: "B", lpReceiver: await alice.getAddress() }) as any);
    const count = await factory.campaignsCount();
    const info = await factory.getCampaign(count - 1n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const lockerAddress = await permanentLpLocker.getAddress();
    expect((campaign.interface as any).getFunction("lpReceiver")).to.equal(null);
    await pastSniperWindow(campaign);

    const curveSupply = await campaign.curveSupply();
    await campaign.connect(alice).buyExactTokens(curveSupply, ethers.MaxUint256, { value: ethers.parseEther("10") });
    await expect(campaign.connect(alice).graduate())
      .to.emit(factory, "CampaignGraduated")
      .withArgs(info.campaign, await creator.getAddress(), anyValue, lockerAddress);

    const state = await campaign.getGraduationState();
    const lpToken = await ethers.getContractAt("MockTopazPool", state[0]);
    expect(await permanentLpLocker.registeredLpToken(state[0])).to.equal(true);
    expect(await permanentLpLocker.lockedBalance(state[0])).to.equal(state[5]);
    expect(await lpToken.balanceOf(lockerAddress)).to.equal(state[5]);
    expect(await lpToken.totalSupply()).to.equal(state[5]);
    expect(await lpToken.balanceOf(await alice.getAddress())).to.equal(0n);
    expect(await lpToken.balanceOf(await creator.getAddress())).to.equal(0n);
    expect(await lpToken.balanceOf(info.campaign)).to.equal(0n);
  });
});
