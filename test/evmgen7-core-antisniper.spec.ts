import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployEvmGen7, createCoin, createScheduledCoin, req, E, area, curveOf, curveFor, launchFeeBps, mineAt, setNextTimestamp,
  signTrade, signCreate, buyTokens, now,
} from "./fixtures/evmgen7Core";

// Gen-7 C6: fee(t) = base + (9000 - base) * max(0, 60 - (t - launchAt)) / 60 (floored), base 200.
// Gen-6 was 5000 - 80 * elapsed; only the start (9000) and the resulting numbers change.

describe("evmgen7 core C6: anti-sniper (launch) fee", function () {
  it("view follows 200 + 8800*(60-t)/60 exactly and is flat from 60 s", async () => {
    const env = await deployEvmGen7();
    const { campaign } = await createCoin(env);
    const t0 = Number(await campaign.launchAt());
    for (const t of [1, 5, 30, 59, 60, 61, 3600]) {
      await mineAt(t0 + t);
      expect(await campaign.currentTradeFeeBps(), `t=${t}`).to.eq(launchFeeBps(t));
    }
  });

  it("non-increasing over the whole window (fuzz)", async () => {
    const env = await deployEvmGen7();
    const { campaign } = await createCoin(env);
    const t0 = Number(await campaign.launchAt());
    let prev = 9000n;
    for (let t = 1; t <= 75; t += 1 + (t % 3)) {
      await mineAt(t0 + t);
      const bps = await campaign.currentTradeFeeBps();
      expect(bps <= prev).to.eq(true);
      expect(bps >= 200n && bps <= 9000n).to.eq(true);
      prev = bps;
    }
  });

  for (const elapsed of [1, 5, 30, 59, 60, 3600]) {
    it(`buy and sell at +${elapsed}s route exactly floor(x*bps/1e4) and the event carries the fee`, async () => {
      const env = await deployEvmGen7();
      const { campaign, token } = await createCoin(env);
      const curve = await curveOf(campaign);
      const t0 = Number(await campaign.launchAt());
      const amount = E(1_000_000);
      const costNoFee = area(amount, curve);
      const bps = launchFeeBps(elapsed);
      const fee = (costNoFee * bps) / 10000n;
      const auth = await signTrade(env.authority, await campaign.getAddress(), env.alice.address, 0, amount, costNoFee * 2n);
      // +0 s is only reachable inside the create block: covered by the sniper test below.
      await setNextTimestamp(t0 + elapsed);
      await expect(
        campaign.connect(env.alice).buyExactTokensAuthorized(amount, costNoFee * 2n, auth.profile, auth.deadline, auth.signature, { value: costNoFee * 2n }),
      )
        .to.emit(campaign, "TokensPurchased")
        .withArgs(env.alice.address, amount, costNoFee + fee);
      expect(await env.evmRouter.lastTradeValue()).to.eq(fee);

      // a sell 2 s later (the approve mines in between) pays the fee of that second
      const sellAt = t0 + elapsed + 2;
      const gross = area(amount, curve); // Y(amount) - Y(0)
      const sellBps = launchFeeBps(elapsed + 2);
      const sellFee = (gross * sellBps) / 10000n;
      await token.connect(env.alice).approve(await campaign.getAddress(), amount);
      const s = await signTrade(env.authority, await campaign.getAddress(), env.alice.address, 2, amount, 0n);
      await setNextTimestamp(sellAt);
      await expect(campaign.connect(env.alice).sellExactTokensAuthorized(amount, 0n, s.profile, s.deadline, s.signature))
        .to.emit(campaign, "TokensSold")
        .withArgs(env.alice.address, amount, gross - sellFee);
      expect(await env.evmRouter.lastTradeValue()).to.eq(sellFee);
    });
  }

  it("a sniper in the create block pays 9000 bps", async () => {
    const env = await deployEvmGen7();
    // The coin's curve is fixed by the oracle at create: $50K at $600.
    const curve = curveFor(50_000, 600);
    const amount = E(1_000_000);
    const costNoFee = area(amount, curve);
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      const r = req();
      const auth = await signCreate(env.authority, await env.factory.getAddress(), env.creator.address, r);
      await env.factory.connect(env.creator).createCampaignAuthorized(r, auth, { gasLimit: 12_000_000 });
      // campaign address is deterministic: predict it from the factory nonce
      const nonce = await ethers.provider.getTransactionCount(await env.factory.getAddress());
      const campaignAddr = ethers.getCreateAddress({ from: await env.factory.getAddress(), nonce });
      const a = await signTrade(env.authority, campaignAddr, env.alice.address, 0, amount, costNoFee * 2n);
      const campaign = await ethers.getContractAt("LaunchCampaignGen7", campaignAddr);
      await campaign.connect(env.alice).buyExactTokensAuthorized(amount, costNoFee * 2n, a.profile, a.deadline, a.signature, { value: costNoFee * 2n, gasLimit: 2_000_000 });
      await ethers.provider.send("evm_mine", []);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
    const count = await env.factory.campaignsCount();
    expect(count).to.eq(1n);
    const campaign = await ethers.getContractAt("LaunchCampaignGen7", (await env.factory.getCampaign(0)).campaign);
    const got = await curveOf(campaign);
    expect(got.vNative).to.eq(curve.vNative);
    expect(got.vToken).to.eq(curve.vToken);
    expect(await env.evmRouter.lastTradeValue()).to.eq((costNoFee * 9000n) / 10000n);
    expect(await campaign.totalBuyVolumeWei()).to.eq(costNoFee);
  });

  it("a buy quoted at +5s and mined at +40s costs less and still passes maxCost", async () => {
    const env = await deployEvmGen7();
    const { campaign } = await createCoin(env);
    const curve = await curveOf(campaign);
    const t0 = Number(await campaign.launchAt());
    const amount = E(2_000_000);
    const costNoFee = area(amount, curve);
    const quotedAt5 = costNoFee + (costNoFee * launchFeeBps(5)) / 10000n;
    const a = await signTrade(env.authority, await campaign.getAddress(), env.alice.address, 0, amount, quotedAt5);
    await setNextTimestamp(t0 + 40);
    await expect(
      campaign.connect(env.alice).buyExactTokensAuthorized(amount, quotedAt5, a.profile, a.deadline, a.signature, { value: quotedAt5 }),
    )
      .to.emit(campaign, "TokensPurchased")
      .withArgs(env.alice.address, amount, costNoFee + (costNoFee * launchFeeBps(40)) / 10000n);
  });

  it("buyExactBnb quote and execution agree inside the window", async () => {
    const env = await deployEvmGen7();
    const { campaign, token } = await createCoin(env);
    const curve = await curveOf(campaign);
    const t0 = Number(await campaign.launchAt());
    const value = E(1);
    const a = await signTrade(env.authority, await campaign.getAddress(), env.alice.address, 1, value, 0n);
    await setNextTimestamp(t0 + 10);
    await campaign.connect(env.alice).buyExactBnbAuthorized(0n, a.profile, a.deadline, a.signature, { value });
    const bal = await token.balanceOf(env.alice.address);
    const bps = launchFeeBps(10);
    const costNoFee = area(bal, curve);
    const fee = (costNoFee * bps) / 10000n;
    expect(await env.evmRouter.lastTradeValue()).to.eq(fee);
    expect(costNoFee + fee <= value).to.eq(true);
    // one more token would not have fit
    const next = area(bal + 1n, curve);
    expect(next + (next * bps) / 10000n > value).to.eq(true);
  });

  it("scheduled coin: buys revert before launchAt and the window starts at launchAt", async () => {
    const env = await deployEvmGen7();
    const launchAt = (await now()) + 600;
    const { campaign } = await createScheduledCoin(env, req(), launchAt);
    expect(await campaign.launchAt()).to.eq(BigInt(launchAt));
    await expect(buyTokens(env, campaign, env.alice, E(1000))).to.be.revertedWithCustomError(campaign, "TradingNotOpen");
    await mineAt(launchAt + 30);
    expect(await campaign.currentTradeFeeBps()).to.eq(4600n); // 200 + 8800 * 30 / 60
  });
});
