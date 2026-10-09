import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployEvmGen7, createCoin, req, E, now, mineAt, buyTokens, buyNative, sellTokens, increaseTime, DAY,
  SUPPLY, CURVE, POOL, RESERVE, curveForMarketCap, nativeForUsd, curveNative, buyCost, sellPayout, priceAt, curveOf,
} from "./fixtures/evmgen7Core";

// Gen-7 = Solana DBC v2 economics on BNB / Robinhood (docs/evm-launch/EVM_GEN7_V2_PLAN.md).
const SEVENTY_PCT = (SUPPLY * 7000n) / 10000n;
const firstBuyValue = (cost: bigint) => cost + (cost * 200n) / 10000n;

describe("evmgen7 C8: factory economics and curve sizing", function () {
  it("config is 1B = 85% curve / 13% pool / 2% reserve, generation 7/6, default target $50K", async () => {
    const env = await deployEvmGen7();
    const c = await env.factory.config();
    expect(c.totalSupply).to.eq(SUPPLY);
    expect(c.curveBps).to.eq(8500n);
    expect(c.liquidityTokenBps).to.eq(1300n);
    expect(c.graduationTarget).to.eq(E(50_000));
    expect(await env.factory.FACTORY_GENERATION()).to.eq(7n);
    expect(await env.factory.CAMPAIGN_GENERATION()).to.eq(6n);
  });

  it("targets: $30K and $50K everywhere; $150 only on BSC / Robinhood / DogeOS testnets; $15K gone", async () => {
    const env = await deployEvmGen7();
    for (const chain of [56n, 4663n, 97n, 46630n, 6281971n]) {
      expect(await env.factory.isGraduationTargetAllowedForChain(chain, E(30_000))).to.eq(true);
      expect(await env.factory.isGraduationTargetAllowedForChain(chain, E(50_000))).to.eq(true);
      expect(await env.factory.isGraduationTargetAllowedForChain(chain, E(15_000))).to.eq(false);
    }
    for (const chain of [97n, 46630n, 6281971n]) expect(await env.factory.isGraduationTargetAllowedForChain(chain, E(150))).to.eq(true);
    for (const chain of [56n, 4663n]) expect(await env.factory.isGraduationTargetAllowedForChain(chain, E(150))).to.eq(false);
    expect(await env.factory.isGraduationTargetAllowedForChain(97n, E(6))).to.eq(false);
  });

  // BNB / ETH prices, and DogeOS's range (DOGE $0.03-$1.00, plan C-D2: no curve scaling needed on gen-7).
  for (const [targetUsd, nativeUsd] of [[30_000, 600], [50_000, 600], [50_000, 3_000], [30_000, 0.03], [50_000, 0.096], [50_000, 1], [150, 0.03]] as const) {
    it(`create sizes the curve from the oracle: $${targetUsd} market cap at $${nativeUsd} native`, async function () {
      const env = await deployEvmGen7({ nativeUsd });
      const { campaign } = await createCoin(env, req({ graduationTarget: E(targetUsd) }));
      const mc = nativeForUsd(E(targetUsd), nativeUsd);
      const want = curveForMarketCap(mc);
      const got = await curveOf(campaign);
      expect(got.vNative).to.eq(want.vNative);
      expect(got.vToken).to.eq(want.vToken);
      // Starting market cap is r^2 x target = 2.4355% (Solana: $731 for $30K, $1,218 for $50K).
      const startMc = (priceAt(0n, got.vNative, got.vToken) * SUPPLY) / E(1);
      expect(Number((startMc * 1_000_000n) / mc) / 1e4).to.be.closeTo(2.4355, 0.01);
      // Sold out, the price is the target market cap (within the 0.01% pool margin).
      const endMc = (priceAt(CURVE, got.vNative, got.vToken) * SUPPLY) / E(1);
      expect(Number((endMc * 1_000_000n) / mc) / 1e4).to.be.closeTo(100, 0.02);
      expect(await campaign.graduationNativeTarget()).to.eq(curveNative(CURVE, got.vNative, got.vToken) - curveNative(0n, got.vNative, got.vToken));
    });
  }

  it("curveForMarketCap matches the reference for any market cap and refuses an absurd one", async () => {
    const env = await deployEvmGen7();
    // Below 0.001 native (MIN_MARKET_CAP_NATIVE) the sold-out price could round to ~0 and strand graduation.
    for (const mc of [1n, E("0.000999"), E("0.001"), E(50), E(83), E(1_000_000)]) {
      if (mc < E("0.001")) {
        await expect(env.factory.curveForMarketCap(mc, SUPPLY, 8500, 1300)).to.be.revertedWithCustomError(env.factory, "TargetOutOfRangeAtPrice");
        continue;
      }
      const [vN, vT] = await env.factory.curveForMarketCap(mc, SUPPLY, 8500, 1300);
      const want = curveForMarketCap(mc);
      expect(vN).to.eq(want.vNative);
      expect(vT).to.eq(want.vToken);
    }
    // A market cap of 1e32 wei (a broken feed) puts the virtual native reserve above MAX_VIRTUAL_NATIVE (1e30).
    await expect(env.factory.curveForMarketCap(10n ** 32n, SUPPLY, 8500, 1300)).to.be.revertedWithCustomError(env.factory, "TargetOutOfRangeAtPrice");
  });

  it("an oracle failure fails the create closed", async () => {
    const env = await deployEvmGen7();
    await env.feed.setRoundData(2, 0, await now(), await now(), 2);
    await expect(createCoin(env, req())).to.be.revertedWithCustomError(env.factory, "OraclePriceUnavailable");
  });

  it("setConfig refuses a curve of 70% or less (the 70% first buy would empty it; F5)", async () => {
    const env = await deployEvmGen7();
    await expect(env.factory.setConfig({ totalSupply: SUPPLY, curveBps: 7000, liquidityTokenBps: 2800, graduationTarget: E(50_000) }))
      .to.be.revertedWithCustomError(env.factory, "InvalidCurveBps");
    await env.factory.setConfig({ totalSupply: SUPPLY, curveBps: 7001, liquidityTokenBps: 1300, graduationTarget: E(50_000) });
  });

  it("a curve whose pool would not fit is refused by setConfig (r >= 1)", async () => {
    const env = await deployEvmGen7();
    // Re-deploy fresh: setConfig is whenMutable (no coins yet). r >= 1 needs curve <= ~50.5%, so the 70% first-buy
    // rule (F5) refuses it first; the empty-pool case still reaches SupplyBoundBroken.
    await expect(env.factory.setConfig({ totalSupply: SUPPLY, curveBps: 1000, liquidityTokenBps: 8800, graduationTarget: E(50_000) }))
      .to.be.revertedWithCustomError(env.factory, "InvalidCurveBps");
    await expect(env.factory.setConfig({ totalSupply: SUPPLY, curveBps: 9999, liquidityTokenBps: 0, graduationTarget: E(50_000) }))
      .to.be.revertedWithCustomError(env.factory, "SupplyBoundBroken");
  });
});

describe("evmgen7 C1/C2: constant-product curve", function () {
  it("buy and sell are exact differences of Y(s); netRaisedWei == Y(sold) - Y(0) after a mixed sequence", async () => {
    const env = await deployEvmGen7();
    const { campaign, token } = await createCoin(env, req());
    const { vNative, vToken } = await curveOf(campaign);
    const t0 = Number(await campaign.launchAt());
    await mineAt(t0 + 61); // past the launch fee
    let sold = 0n;
    const steps: [string, bigint][] = [["buy", E(12_345_678)], ["buy", E(98_765_432)], ["sell", E(5_000_000)], ["buy", E(1)], ["sell", E(40_000_000)], ["buy", E(250_000_000)]];
    for (const [side, amount] of steps) {
      if (side === "buy") {
        const cost = buyCost(sold, amount, vNative, vToken);
        expect(await campaign.quoteBuyExactTokens(amount)).to.eq(cost + (cost * 200n) / 10000n);
        await buyTokens(env, campaign, env.alice, amount);
        sold += amount;
      } else {
        const gross = sellPayout(sold, amount, vNative, vToken);
        expect(await campaign.quoteSellExactTokens(amount)).to.eq(gross - (gross * 200n) / 10000n);
        await sellTokens(env, campaign, token, env.alice, amount);
        sold -= amount;
      }
      expect(await campaign.sold()).to.eq(sold);
      expect(await campaign.netRaisedWei()).to.eq(curveNative(sold, vNative, vToken) - curveNative(0n, vNative, vToken));
      expect(await campaign.currentPrice()).to.eq(priceAt(sold, vNative, vToken));
    }
  });

  it("a buy then a sell of the same tokens returns exactly the curve cost (no rounding gain or loss, fees aside)", async () => {
    const env = await deployEvmGen7();
    const { campaign, token } = await createCoin(env, req());
    await mineAt(Number(await campaign.launchAt()) + 61);
    for (const amount of [1n, 7n, E("0.000001"), E(333_333), E(10_000_000)]) {
      const raisedBefore = await campaign.netRaisedWei();
      await buyTokens(env, campaign, env.alice, amount);
      await sellTokens(env, campaign, token, env.alice, amount);
      expect(await campaign.netRaisedWei()).to.eq(raisedBefore);
    }
  });

  it("price only rises with sold, and a buy for native gets the most tokens it can pay for", async () => {
    const env = await deployEvmGen7();
    const { campaign } = await createCoin(env, req());
    const { vNative, vToken } = await curveOf(campaign);
    // Never falls; strictly rises over any real step (one wei of token can move it by less than a wei).
    let last = -1n;
    for (const s of [0n, E(1), E(100_000_000), E(500_000_000), CURVE - E(1), CURVE]) {
      const p = priceAt(s, vNative, vToken);
      expect(p > last).to.eq(true);
      last = p;
    }
    expect(priceAt(CURVE, vNative, vToken) >= priceAt(CURVE - 1n, vNative, vToken)).to.eq(true);
    await mineAt(Number(await campaign.launchAt()) + 61);
    const [out, total] = await campaign.quoteBuyExactBnb(E(1));
    expect(buyCost(0n, out, vNative, vToken) + (buyCost(0n, out, vNative, vToken) * 200n) / 10000n).to.eq(total);
    expect(total <= E(1)).to.eq(true);
    const next = buyCost(0n, out + 1n, vNative, vToken);
    expect(next + (next * 200n) / 10000n > E(1)).to.eq(true);
    await buyNative(env, campaign, env.bob, E(1));
    expect(await campaign.sold()).to.eq(out);
  });
});

describe("evmgen7 C5/C6/C7: first buy, launch fee, creator buys", function () {
  it("first buy of exactly 70% at flat 2%, no cost cap; 70% + 1 wei refused", async () => {
    const env = await deployEvmGen7();
    const mc = nativeForUsd(E(50_000), 600);
    const { vNative, vToken } = curveForMarketCap(mc);
    const cost = buyCost(0n, SEVENTY_PCT, vNative, vToken);
    const value = firstBuyValue(cost);
    // 70% costs 42.1% of the raise for any target.
    const raise = curveNative(CURVE, vNative, vToken) - curveNative(0n, vNative, vToken);
    expect(Number((cost * 10_000n) / raise) / 100).to.be.closeTo(42.14, 0.02);
    const { campaign, token } = await createCoin(env, req({ firstBuyTokens: SEVENTY_PCT, firstBuyMaxCost: value }), { value });
    expect(await token.balanceOf(env.creator.address)).to.eq(SEVENTY_PCT);
    expect(await campaign.creatorEscrowTotal()).to.eq(0n);
    expect(await campaign.graduationPending()).to.eq(false);
    expect(await campaign.netRaisedWei()).to.eq(cost);
    expect(await env.evmRouter.lastTradeValue()).to.eq((cost * 200n) / 10000n);
    // The public still has 15% of supply on the curve.
    expect(CURVE - (await campaign.sold())).to.eq((SUPPLY * 1500n) / 10000n);

    const env2 = await deployEvmGen7();
    const tooMuch = SEVENTY_PCT + 1n;
    const v2 = firstBuyValue(buyCost(0n, tooMuch, vNative, vToken));
    await expect(createCoin(env2, req({ firstBuyTokens: tooMuch, firstBuyMaxCost: v2 }), { value: v2 })).to.be.revertedWithCustomError(env2.impl, "FirstBuyTooLarge");
  });

  it("launch fee is 90% at launch, falls linearly to 2% at 60 s and stays there", async () => {
    const env = await deployEvmGen7();
    const { campaign } = await createCoin(env, req());
    const t0 = Number(await campaign.launchAt());
    const expectAt = async (dt: number, bps: bigint) => {
      await mineAt(t0 + dt);
      expect(await campaign.currentTradeFeeBps()).to.eq(bps);
    };
    await expectAt(1, 200n + ((9000n - 200n) * 59n) / 60n);
    await expectAt(30, 200n + ((9000n - 200n) * 30n) / 60n);
    await expectAt(59, 200n + ((9000n - 200n) * 1n) / 60n);
    await expectAt(60, 200n);
    await expectAt(3600, 200n);
  });

  it("creator buys after launch have no cap and go into the 30-day + weekly escrow", async () => {
    const env = await deployEvmGen7();
    const { campaign, token } = await createCoin(env, req());
    await mineAt(Number(await campaign.launchAt()) + 61);
    const big = E(300_000_000); // 30% of supply in one go: far above gen-6's 0.25-3 native caps
    await buyTokens(env, campaign, env.creator, big);
    expect(await campaign.creatorEscrowTotal()).to.eq(big);
    expect(await token.balanceOf(env.creator.address)).to.eq(0n);
    expect(await campaign.creatorBuyCapWei()).to.eq(0n);
    await increaseTime(30 * DAY);
    expect(await campaign.creatorEscrowClaimable()).to.eq(big / 5n);
    await campaign.connect(env.creator).claimCreatorEscrow();
    expect(await token.balanceOf(env.creator.address)).to.eq(big / 5n);
  });
});

describe("evmgen7 C4: graduation at the target market cap", function () {
  for (const targetUsd of [30_000, 50_000]) {
    it(`$${targetUsd}: sold out -> Pending; 2% to the router, 0% creator, 98% + 13% to the pool, 2% reserve to the creator`, async () => {
      const env = await deployEvmGen7();
      const { campaign, token } = await createCoin(env, req({ graduationTarget: E(targetUsd) }));
      const { vNative, vToken } = await curveOf(campaign);
      await mineAt(Number(await campaign.launchAt()) + 61);
      await buyTokens(env, campaign, env.alice, CURVE - E(1));
      expect(await campaign.graduationPending()).to.eq(false);
      await buyTokens(env, campaign, env.bob, E(1));
      expect(await campaign.graduationPending()).to.eq(true);
      expect(await campaign.pendingTrigger()).to.eq(1n);

      const raise = curveNative(CURVE, vNative, vToken) - curveNative(0n, vNative, vToken);
      expect(await campaign.netRaisedWei()).to.eq(raise);
      const finalizeBefore = await env.evmRouter.finalizeTotal();
      await campaign.connect(env.carol).graduate();
      const protocol = (raise * 200n) / 10000n;
      expect((await env.evmRouter.finalizeTotal()) - finalizeBefore).to.eq(protocol);
      expect(await campaign.pendingCreatorGraduation()).to.eq(0n);
      const g = await campaign.getGraduationState();
      const price = priceAt(CURVE, vNative, vToken);
      expect(g.finalCurvePrice).to.eq(price);
      // Pool: 98% of the raise against 99.99% of the 13% allocation; the 0.01% margin is burned.
      expect(g.graduatedLiquidityBnb).to.eq(raise - protocol);
      expect(g.graduatedLiquidityTokens).to.eq(((raise - protocol) * E(1)) / price);
      expect(Number((g.graduatedLiquidityTokens * 1_000_000n) / POOL) / 1e4).to.be.closeTo(99.99, 0.005);
      expect(g.burnedUnsoldTokens).to.eq(POOL - g.graduatedLiquidityTokens);
      expect(await token.balanceOf(env.creator.address)).to.eq(RESERVE);
      expect(g.postBurnTotalSupply).to.eq(SUPPLY - g.burnedUnsoldTokens);
      // Graduation market cap = the target at the oracle price (within the margin).
      const mc = nativeForUsd(E(targetUsd), 600);
      expect(Number((((price * SUPPLY) / E(1)) * 1_000_000n) / mc) / 1e4).to.be.closeTo(100, 0.02);
      expect(await campaign.launched()).to.eq(true);
    });
  }

  it("a 70% first buy, then the public's 15%, graduates normally", async () => {
    const env = await deployEvmGen7();
    const mc = nativeForUsd(E(30_000), 600);
    const { vNative, vToken } = curveForMarketCap(mc);
    const value = firstBuyValue(buyCost(0n, SEVENTY_PCT, vNative, vToken));
    const { campaign } = await createCoin(env, req({ graduationTarget: E(30_000), firstBuyTokens: SEVENTY_PCT, firstBuyMaxCost: value }), { value });
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyTokens(env, campaign, env.alice, CURVE - SEVENTY_PCT);
    expect(await campaign.graduationPending()).to.eq(true);
    await campaign.graduate();
    expect(await campaign.launched()).to.eq(true);
  });

  it("the router refusing the 2% escrows it for a permissionless flush; graduation still completes", async () => {
    const env = await deployEvmGen7();
    const { campaign } = await createCoin(env, req());
    const { vNative, vToken } = await curveOf(campaign);
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyTokens(env, campaign, env.alice, CURVE);
    await env.evmRouter.setReverts(false, true);
    await campaign.graduate();
    const raise = curveNative(CURVE, vNative, vToken) - curveNative(0n, vNative, vToken);
    expect(await campaign.pendingProtocolGraduationFee()).to.eq((raise * 200n) / 10000n);
    await env.evmRouter.setReverts(false, false);
    await campaign.flushProtocolGraduationFee();
    expect(await campaign.pendingProtocolGraduationFee()).to.eq(0n);
  });
});
