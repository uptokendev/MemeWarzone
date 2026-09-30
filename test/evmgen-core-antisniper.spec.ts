import { expect } from "chai";
import { ethers } from "hardhat";
import { deployEvmGen, createCoin, req, E, area, mineAt, setNextTimestamp, signTrade, buyTokens, sellTokens, now } from "./fixtures/evmgenCore";

// C2: fee(t) = base + (5000 - base) * max(0, 60 - (t - launchAt)) / 60, base 200 => 5000 - 80 * elapsed.
const expectedBps = (elapsed: number) => (elapsed >= 60 ? 200 : 5000 - 80 * Math.max(0, elapsed));

describe("evmgen core C2: anti-sniper fee", function () {
  it("view follows 5000 - 80*t exactly and is flat from 60 s", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env);
    const t0 = Number(await campaign.launchAt());
    for (const t of [1, 5, 30, 59, 60, 61, 3600]) {
      await mineAt(t0 + t);
      expect(await campaign.currentTradeFeeBps(), `t=${t}`).to.eq(BigInt(expectedBps(t)));
    }
  });

  it("non-increasing over the whole window (fuzz)", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env);
    const t0 = Number(await campaign.launchAt());
    let prev = 5000n;
    for (let t = 1; t <= 75; t += 1 + (t % 3)) {
      await mineAt(t0 + t);
      const bps = await campaign.currentTradeFeeBps();
      expect(bps <= prev).to.eq(true);
      expect(bps >= 200n && bps <= 5000n).to.eq(true);
      prev = bps;
    }
  });

  for (const elapsed of [1, 5, 30, 59, 60, 3600]) {
    it(`buy and sell at +${elapsed}s route exactly floor(x*bps/1e4) and the event carries the fee`, async () => {
      const env = await deployEvmGen();
      const { campaign, token } = await createCoin(env);
      const t0 = Number(await campaign.launchAt());
      const amount = E(1_000_000);
      const costNoFee = area(amount);
      const bps = BigInt(expectedBps(elapsed));
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
      const gross = area(amount) - area(0n);
      const sellBps = BigInt(expectedBps(elapsed + 2));
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

  it("a sniper in the create block pays 5000 bps", async () => {
    const env = await deployEvmGen();
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      const r = req();
      const { signCreate } = await import("./fixtures/evmgenCore");
      const auth = await signCreate(env.authority, await env.factory.getAddress(), env.creator.address, r);
      await env.factory.connect(env.creator).createCampaignAuthorized(r, auth, { gasLimit: 12_000_000 });
      // campaign address is deterministic: predict it from the factory nonce
      const nonce = await ethers.provider.getTransactionCount(await env.factory.getAddress());
      const campaignAddr = ethers.getCreateAddress({ from: await env.factory.getAddress(), nonce });
      const amount = E(1_000_000);
      const costNoFee = area(amount);
      const a = await signTrade(env.authority, campaignAddr, env.alice.address, 0, amount, costNoFee * 2n);
      const campaign = await ethers.getContractAt("LaunchCampaign", campaignAddr);
      await campaign.connect(env.alice).buyExactTokensAuthorized(amount, costNoFee * 2n, a.profile, a.deadline, a.signature, { value: costNoFee * 2n, gasLimit: 2_000_000 });
      await ethers.provider.send("evm_mine", []);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
    const count = await env.factory.campaignsCount();
    expect(count).to.eq(1n);
    const campaign = await ethers.getContractAt("LaunchCampaign", (await env.factory.getCampaign(0)).campaign);
    const costNoFee = area(E(1_000_000));
    expect(await env.evmRouter.lastTradeValue()).to.eq((costNoFee * 5000n) / 10000n);
    expect(await campaign.totalBuyVolumeWei()).to.eq(costNoFee);
  });

  it("a buy quoted at +5s and mined at +40s costs less and still passes maxCost", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env);
    const t0 = Number(await campaign.launchAt());
    const amount = E(2_000_000);
    const costNoFee = area(amount);
    const quotedAt5 = costNoFee + (costNoFee * 4600n) / 10000n;
    const a = await signTrade(env.authority, await campaign.getAddress(), env.alice.address, 0, amount, quotedAt5);
    await setNextTimestamp(t0 + 40);
    await expect(
      campaign.connect(env.alice).buyExactTokensAuthorized(amount, quotedAt5, a.profile, a.deadline, a.signature, { value: quotedAt5 }),
    )
      .to.emit(campaign, "TokensPurchased")
      .withArgs(env.alice.address, amount, costNoFee + (costNoFee * 1800n) / 10000n);
  });

  it("buyExactBnb quote and execution agree inside the window", async () => {
    const env = await deployEvmGen();
    const { campaign, token } = await createCoin(env);
    const t0 = Number(await campaign.launchAt());
    const value = E(1);
    const a = await signTrade(env.authority, await campaign.getAddress(), env.alice.address, 1, value, 0n);
    await setNextTimestamp(t0 + 10);
    await campaign.connect(env.alice).buyExactBnbAuthorized(0n, a.profile, a.deadline, a.signature, { value });
    const bal = await token.balanceOf(env.alice.address);
    const costNoFee = area(bal);
    const fee = (costNoFee * 4200n) / 10000n;
    expect(await env.evmRouter.lastTradeValue()).to.eq(fee);
    expect(costNoFee + fee <= value).to.eq(true);
    // one more token would not have fit
    const next = area(bal + 1n);
    expect(next + (next * 4200n) / 10000n > value).to.eq(true);
  });

  it("scheduled coin: buys revert before launchAt and the window starts at launchAt", async () => {
    const env = await deployEvmGen();
    const { signCreate, hashReq } = await import("./fixtures/evmgenCore");
    const r = req();
    const t = await now();
    const launchAt = t + 600;
    const sreq = {
      campaign: r,
      launchAt,
      draftReferenceHash: ethers.id("draft"),
      normalizedTickerHash: ethers.id("EGEN"),
      metadataHash: ethers.id("meta"),
      reservationVersion: 1,
      authorizationNonce: 7,
    };
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const dl = t + 3600;
    const payload = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256", "address", "address", "bytes32", "uint64", "bytes32", "bytes32", "bytes32", "uint64", "uint256", "uint32", "uint32", "uint8", "uint8", "uint64"],
        ["MWZ_CREATE_SCHEDULED_V2_AUTH", chainId, await env.factory.getAddress(), env.creator.address, hashReq(r), launchAt, sreq.draftReferenceHash, sreq.normalizedTickerHash, sreq.metadataHash, 1, 7, 6, 5, 1, 1, dl],
      ),
    );
    const sig = await env.authority.signMessage(ethers.getBytes(payload));
    void signCreate;
    await env.factory.connect(env.creator).createScheduledCampaignAuthorized(sreq, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature: sig });
    const campaign = await ethers.getContractAt("LaunchCampaign", (await env.factory.getCampaign(0)).campaign);
    expect(await campaign.launchAt()).to.eq(BigInt(launchAt));
    await expect(buyTokens(env, campaign, env.alice, E(1000))).to.be.revertedWithCustomError(campaign, "TradingNotOpen");
    await mineAt(launchAt + 30);
    expect(await campaign.currentTradeFeeBps()).to.eq(2600n);
    void sellTokens;
  });
});
