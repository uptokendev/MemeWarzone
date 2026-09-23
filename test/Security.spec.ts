import { expect } from "chai";
import { ethers } from "hardhat";

import { deployCoreFixture } from "./fixtures/core";

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
  it("auto-finalize cannot be skipped: crossing buy flips launched in same tx", async function () {
    const { owner, creator, alice, factory } = await deployCoreFixture();

    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000,
      liquidityTokenBps: 4000,
      basePrice: ethers.parseEther("0.005"),
      priceSlope: 10n ** 9n,
      graduationTarget: ethers.parseEther("0.005"),
      liquidityBps: 8000,
    });

    await factory.connect(creator).createCampaign(req({ lpReceiver: await alice.getAddress() }) as any);
    const count = await factory.campaignsCount();
    const info = await factory.getCampaign(count - 1n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);

    const buyValue = await campaign.quoteBuyExactTokens(ethers.parseUnits("1", 18));
    const buyTx = await campaign.connect(alice).buyExactBnb(0, { value: buyValue });
    const buyRc = await buyTx.wait();

    const finalized = buyRc!.logs.some((l: any) => l.fragment?.name === "CampaignFinalized");
    expect(finalized).to.equal(true);
    expect(await campaign.launched()).to.equal(true);
  });

  it("finalize fee amounts: protocolFee equals netRaisedWei * protocolFeeBps / 10000", async function () {
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
      liquidityBps: 8000,
    });
    await factory.connect(owner).setProtocolFee(200);

    await factory.connect(creator).createCampaign(req({ name: "F", symbol: "F" }) as any);
    const count = await factory.campaignsCount();
    const info = await factory.getCampaign(count - 1n);
    const campaignAddr = info.campaign;
    const campaign = await ethers.getContractAt("LaunchCampaign", campaignAddr);

    const oneToken = ethers.parseUnits("1", 18);
    const q = await campaign.quoteBuyExactTokens(oneToken);
    const qBuf = q + 1n;
    await campaign.connect(alice).buyExactTokens(oneToken, qBuf, { value: qBuf });
    await makeGraduationEligibleByOracle(campaign, priceFeed);

    const graduationPrincipal = await campaign.netRaisedWei();
    const expectedFee = (graduationPrincipal * 200n) / 10_000n;
    const routeVaults = { treasuryVault, monthlyLeagueReceiver, creatorVault, recruiterVault, communityVault, protocolVault };
    const routeBefore = await captureRouteBalances(routeVaults);

    const finTx = await campaign.connect(alice).graduateIfEligible(0, 0);
    const finRc = await finTx.wait();

    let finParsed: any = null;
    for (const log of finRc!.logs) {
      try {
        const p = campaign.interface.parseLog(log);
        if (p.name === "CampaignFinalized") {
          finParsed = p;
          break;
        }
      } catch {}
    }
    expect(finParsed).to.not.equal(null);
    expect(finParsed!.args.protocolFee).to.equal(expectedFee);

    const expectedRoute = await treasuryRouter.previewRoute(expectedFee, 1, await campaign.finalizeRouteProfile());
    await expectRouteBalanceDelta(routeBefore, routeVaults, expectedRoute);
  });

  it("DEX reserves correctness: LP deploy results in non-zero pair reserves when pair is registered", async function () {
    const { owner, creator, alice, factory, v2factory, router } = await deployCoreFixture();

    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 1000,
      liquidityTokenBps: 8000,
      basePrice: 10n ** 12n,
      priceSlope: 10n ** 9n,
      graduationTarget: 1n,
      liquidityBps: 8000,
    });

    await factory.connect(creator).createCampaign(req({ name: "P", symbol: "P" }) as any);
    const count = await factory.campaignsCount();
    const info = await factory.getCampaign(count - 1n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const tokenAddr = await campaign.token();

    const Pool = await ethers.getContractFactory("MockTopazPool");
    const pool = await Pool.deploy();
    await v2factory.setPool(tokenAddr, await router.WETH(), false, await pool.getAddress());

    const curveSupply = await campaign.curveSupply();
    await campaign.connect(alice).buyExactTokens(curveSupply, ethers.MaxUint256, { value: ethers.parseEther("10") });

    const reserves = await pool.getReserves();
    expect(reserves[0]).to.be.gt(0);
    expect(reserves[1]).to.be.gt(0);
    expect(await pool.totalSupply()).to.be.gt(0);
    const state = await campaign.getGraduationState();
    expect(state[0]).to.equal(await pool.getAddress());
  });

  it("reentrancy defense: a fee recipient that cannot route takes nothing and re-enters nothing", async function () {
    // Under strict fee routing the defense is stronger than escrow-and-continue.
    // LaunchFactory creates every campaign with strictFeeRouting: true, so a fee
    // recipient that cannot service routeTrade does not get to keep the value
    // and try again from inside a callback -- the whole buy reverts atomically,
    // and there is no partial state for a reentrant call to sit on.
    const { owner, creator, alice, factory, router } = await deployCoreFixture();

    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 5000,
      liquidityTokenBps: 4000,
      basePrice: 10n ** 12n,
      priceSlope: 10n ** 9n,
      graduationTarget: ethers.parseEther("100"),
      liquidityBps: 8000,
    });

    const Reenter = await ethers.getContractFactory("ReenteringFeeRecipient");
    const reenter = await Reenter.deploy();
    await factory.connect(owner).setCoreRouting(await router.getAddress(), await reenter.getAddress());

    await factory.connect(creator).createCampaign(req({ name: "R", symbol: "R", graduationTarget: ethers.parseEther("100") }) as any);
    const count = await factory.campaignsCount();
    const info = await factory.getCampaign(count - 1n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const token = await ethers.getContractAt("LaunchToken", await campaign.token());
    await reenter.setTarget(info.campaign);

    const oneToken = ethers.parseUnits("1", 18);
    const quote = await campaign.quoteBuyExactTokens(oneToken);
    const withBuffer = quote + 1n;

    for (const mode of [0, 1]) {
      await reenter.setMode(mode);
      const soldBefore = await campaign.sold();
      const attackerBefore = await ethers.provider.getBalance(await reenter.getAddress());

      await expect(campaign.connect(alice).buyExactTokens(oneToken, withBuffer, { value: withBuffer })).to.be.reverted;

      expect(await campaign.sold()).to.eq(soldBefore);
      expect(await token.balanceOf(await alice.getAddress())).to.eq(0n);
      expect(await ethers.provider.getBalance(await reenter.getAddress())).to.eq(attackerBefore);
      expect(await campaign.pendingNative(await reenter.getAddress())).to.eq(0n);
      expect(await reenter.lastReenterOk()).to.eq(false);
    }
  });

  it("LP lock cannot be bypassed: factory ignores user lpReceiver and liquidity LP is minted to locker", async function () {
    const { owner, creator, alice, factory, router, permanentLpLocker } = await deployCoreFixture();

    await factory.connect(owner).setConfig({
      totalSupply: ethers.parseEther("1000"),
      curveBps: 1000,
      liquidityTokenBps: 8000,
      basePrice: 10n ** 12n,
      priceSlope: 10n ** 9n,
      graduationTarget: 1n,
      liquidityBps: 8000,
    });

    await factory.connect(creator).createCampaign(req({ name: "B", symbol: "B", lpReceiver: await alice.getAddress() }) as any);
    const count = await factory.campaignsCount();
    const info = await factory.getCampaign(count - 1n);
    const campaign = await ethers.getContractAt("LaunchCampaign", info.campaign);
    const lockerAddress = await permanentLpLocker.getAddress();

    expect(await campaign.lpReceiver()).to.equal(lockerAddress);

    const curveSupply = await campaign.curveSupply();
    const tx = await campaign.connect(alice).buyExactTokens(curveSupply, ethers.MaxUint256, { value: ethers.parseEther("10") });
    const rc = await tx.wait();

    let liqParsed: any = null;
    for (const log of rc!.logs) {
      try {
        const p = router.interface.parseLog(log);
        if (p.name === "LiquidityAdded") {
          liqParsed = p;
          break;
        }
      } catch {}
    }
    expect(liqParsed).to.not.equal(null);
    expect(liqParsed!.args[3]).to.equal(lockerAddress);

    const state = await campaign.getGraduationState();
    const lpToken = await ethers.getContractAt("MockTopazPool", state[0]);
    expect(await permanentLpLocker.registeredLpToken(state[0])).to.equal(true);
    expect(await permanentLpLocker.lockedBalance(state[0])).to.equal(state[5]);
    expect(await lpToken.balanceOf(lockerAddress)).to.equal(state[5]);
  });
});
