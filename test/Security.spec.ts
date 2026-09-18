import { expect } from "chai";
import { ethers } from "hardhat";

import { completeNativeGraduation, deployCoreFixture } from "./fixtures/core";

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

async function captureRouteBalances(vaults: any) {
  return {
    league: await ethers.provider.getBalance(await vaults.treasuryVault.getAddress()),
    recruiter: await ethers.provider.getBalance(await vaults.recruiterVault.getAddress()),
    airdrop: await vaults.communityVault.warzoneAirdropBalance(),
    squad: await vaults.communityVault.squadPoolBalance(),
    protocol: await ethers.provider.getBalance(await vaults.protocolVault.getAddress()),
  };
}

async function expectRouteBalanceDelta(before: any, vaults: any, expected: any) {
  const after = await captureRouteBalances(vaults);
  expect(after.league - before.league).to.eq(expected.league);
  expect(after.recruiter - before.recruiter).to.eq(expected.recruiter);
  expect(after.airdrop - before.airdrop).to.eq(expected.airdrop);
  expect(after.squad - before.squad).to.eq(expected.squad);
  expect(after.protocol - before.protocol).to.eq(expected.protocol);
}

describe("Security & invariants", function () {
  it("auto-finalize cannot be skipped: crossing buy flips pending then completion launches", async function () {
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
    await expect(buyTx).to.emit(campaign, "StockGraduationPending");
    expect(await campaign.graduationPending()).to.equal(true);
    expect(await campaign.launched()).to.equal(false);
    await completeNativeGraduation(campaign, alice);
    expect(await campaign.launched()).to.equal(true);
    expect(await campaign.graduationPending()).to.equal(false);
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
    await campaign.connect(alice).graduateIfEligible(0, 0);
    expect(await campaign.graduationPending()).to.equal(true);

    const graduationPrincipal = await campaign.netRaisedWei();
    const expectedFee = (graduationPrincipal * 200n) / 10_000n;
    const routeVaults = { treasuryVault, recruiterVault, communityVault, protocolVault };
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
    await completeNativeGraduation(campaign, alice);

    const reserves = await pool.getReserves();
    expect(reserves[0]).to.be.gt(0);
    expect(reserves[1]).to.be.gt(0);
    expect(await pool.totalSupply()).to.be.gt(0);
    const state = await campaign.getGraduationState();
    expect(state[0]).to.equal(await pool.getAddress());
  });

  it("reentrancy defense: feeRecipient cannot re-enter claimPendingNative during buy", async function () {
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
    await reenter.setTarget(info.campaign);

    const oneToken = ethers.parseUnits("1", 18);
    const q1 = await campaign.quoteBuyExactTokens(oneToken);
    const q1Buf = q1 + 1n;
    await reenter.setMode(0);
    await campaign.connect(alice).buyExactTokens(oneToken, q1Buf, { value: q1Buf });
    const pending1 = await campaign.pendingNative(await reenter.getAddress());
    expect(pending1).to.be.gt(0);

    const q2 = await campaign.quoteBuyExactTokens(oneToken);
    const q2Buf = q2 + 1n;
    await reenter.setMode(1);
    await campaign.connect(alice).buyExactTokens(oneToken, q2Buf, { value: q2Buf });

    expect(await reenter.lastReenterOk()).to.equal(false);
    const pending2 = await campaign.pendingNative(await reenter.getAddress());
    expect(pending2).to.be.gt(0);
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
