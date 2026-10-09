import { expect } from "chai";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deployEvmGen7, createCoin, req, E, buyTokens, sellTokens, nativeForUsd, SUPPLY, CURVE } from "./fixtures/evmgen7Core";

// Step 3: frontend/shared/evmGen7Curve.mjs (what the app and the API quote with) must equal the contracts
// to the wei. Native ESM import from a CommonJS test: keep the dynamic import out of ts-node's reach.
const esmImport = new Function("p", "return import(p)") as (p: string) => Promise<any>;
const MODULE = pathToFileURL(path.join(__dirname, "..", "frontend", "shared", "evmGen7Curve.mjs")).href;

describe("evmgen7 step 3: off-chain curve module mirrors the contracts", function () {
  let m: any;
  before(async () => {
    m = await esmImport(MODULE);
  });

  for (const [targetUsd, nativeUsd] of [[50_000, 600], [30_000, 600], [50_000, 3_000], [150, 0.03], [50_000, 0.096]] as const) {
    it(`$${targetUsd} at $${nativeUsd}: sizing, first-buy plan, buys, sells, price and raise equal the chain`, async () => {
      const env = await deployEvmGen7({ nativeUsd });
      // At a cheap native price the first buy needs thousands of native; earlier suites drain the test account.
      await ethers.provider.send("hardhat_setBalance", [await env.creator.getAddress(), "0x" + E(1_000_000).toString(16)]);
      const target = E(targetUsd);
      const mc = BigInt(await env.oracle.nativeTargetForUsd(target));
      expect(mc).to.eq(nativeForUsd(target, nativeUsd));
      const config = await env.factory.config();
      const protocolFeeBps = BigInt(await env.factory.protocolFeeBps());

      // The factory's own view and the module agree on the curve for this market cap.
      const onChainCurve = await env.factory.curveForMarketCap(mc, SUPPLY, 8500n, 1300n);
      const offChain = m.curveForMarketCap(mc, SUPPLY, 8500n, 1300n);
      expect(offChain.virtualNative).to.eq(onChainCurve[0]);
      expect(offChain.virtualToken).to.eq(onChainCurve[1]);

      // A 30% budget-of-the-max first buy planned off chain, sent with the planned total, mints exactly that.
      const max = m.planGen7FirstBuy({ budgetWei: 0n, config, protocolFeeBps, marketCapNativeWei: mc });
      expect(max.maxTokens).to.eq((SUPPLY * 7000n) / 10000n);
      const plan = m.planGen7FirstBuy({ budgetWei: max.maxTotalWei / 3n, config, protocolFeeBps, marketCapNativeWei: mc });
      expect(plan.tokens > 0n).to.eq(true);
      const { campaign, token } = await createCoin(env, req({ graduationTarget: target, firstBuyTokens: plan.tokens, firstBuyMaxCost: plan.total }), { value: plan.total });
      const vN = BigInt(await campaign.virtualNative());
      const vT = BigInt(await campaign.virtualToken());
      expect(vN).to.eq(offChain.virtualNative);
      expect(vT).to.eq(offChain.virtualToken);
      expect(BigInt(await campaign.sold())).to.eq(plan.tokens);
      expect(BigInt(await campaign.netRaisedWei())).to.eq(plan.costNoFee);
      expect(BigInt(await campaign.graduationNativeTarget())).to.eq(m.graduationRaise(vN, vT, CURVE));
      expect(plan.graduationRaiseWei).to.eq(m.graduationRaise(vN, vT, CURVE));

      // Trades after the launch window: quotes and price equal the module at every step.
      await ethers.provider.send("evm_increaseTime", [120]);
      await ethers.provider.send("evm_mine", []);
      const fee = BigInt(await campaign.currentTradeFeeBps());
      expect(fee).to.eq(protocolFeeBps);
      for (const amount of [1n, E(1), E(12_345_678), CURVE / 50n]) {
        const sold = BigInt(await campaign.sold());
        const noFee = m.buyCostNoFee(vN, vT, sold, amount);
        expect(BigInt(await campaign.quoteBuyExactTokens(amount))).to.eq(noFee + (noFee * fee) / 10000n);
        expect(BigInt(await campaign.currentPrice())).to.eq(m.spotPrice(vN, vT, sold));
        await buyTokens(env, campaign, env.alice, amount);
      }
      const sold = BigInt(await campaign.sold());
      const sellAmount = E(5_000_000);
      const payout = m.sellPayoutNoFee(vN, vT, sold, sellAmount);
      expect(BigInt(await campaign.quoteSellExactTokens(sellAmount))).to.eq(payout - (payout * fee) / 10000n);
      await sellTokens(env, campaign, token, env.alice, sellAmount);
      const after = BigInt(await campaign.sold());
      expect(BigInt(await campaign.currentPrice())).to.eq(m.spotPrice(vN, vT, after));
      expect(BigInt(await campaign.netRaisedWei())).to.eq(m.curveNative(vN, vT, after) - m.curveNative(vN, vT, 0n));
      // Sold-out market cap equals the target within the pool margin.
      const endMc = m.gen7MarketCapNative({ virtualNative: vN, virtualToken: vT, sold: CURVE, totalSupply: SUPPLY });
      expect(Number((endMc * 1_000_000n) / mc) / 1e4).to.be.closeTo(100, 0.02);
    });
  }

  it("the module refuses what the factory refuses (market cap below the floor)", async () => {
    const env = await deployEvmGen7();
    await expect(env.factory.curveForMarketCap(E("0.000999"), SUPPLY, 8500n, 1300n)).to.be.revertedWithCustomError(env.factory, "TargetOutOfRangeAtPrice");
    expect(() => m.curveForMarketCap(E("0.000999"), SUPPLY, 8500n, 1300n)).to.throw("TargetOutOfRangeAtPrice");
  });

  it("targets and constants match the factory and campaign", async () => {
    const env = await deployEvmGen7();
    expect(BigInt(await env.factory.FACTORY_GENERATION())).to.eq(BigInt(m.EVM_GEN7_FACTORY_GENERATION));
    expect(BigInt(await env.factory.CAMPAIGN_GENERATION())).to.eq(BigInt(m.EVM_GEN7_CAMPAIGN_GENERATION));
    expect(BigInt(await env.factory.MIN_MARKET_CAP_NATIVE())).to.eq(m.GEN7_MIN_MARKET_CAP_NATIVE);
    expect(BigInt(await env.factory.MAX_VIRTUAL_NATIVE())).to.eq(m.GEN7_MAX_VIRTUAL_NATIVE);
    expect(BigInt(await env.factory.POOL_MARGIN_BPS())).to.eq(m.GEN7_POOL_MARGIN_BPS);
    expect(BigInt(await env.factory.FIRST_BUY_MAX_SUPPLY_BPS())).to.eq(m.GEN7_FIRST_BUY_MAX_SUPPLY_BPS);
    for (const chain of [56, 4663, 97, 46630, 6281971]) {
      for (const usd of [150, 6, 15_000, 30_000, 50_000]) {
        expect(m.isGen7TargetAllowed(chain, E(usd))).to.eq(await env.factory.isGraduationTargetAllowedForChain(chain, E(usd)));
      }
    }
    // The campaign's constants are private: the launch fee in the create block is the 90% start.
    const { campaign } = await createCoin(env);
    expect(Number(await campaign.currentTradeFeeBps())).to.eq(m.GEN7_ANTI_SNIPER_START_BPS);
  });
});

import { ethers } from "hardhat";
