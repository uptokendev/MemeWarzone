/**
 * Gen-7 port of evmgen-core-repair.spec.ts. C5/C7: the campaign's permissionless chunked pool repair, `repairPool(uint160 limit)`, and how
 * graduate() consumes earlier steps. Unit level, against MockGraduationAdapterEvmGen.repairStep
 * (the real V3 path is covered by test/evmgen-rh-core-integration.fork.spec.ts).
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployEvmGen7, deployBnbQuoteGen7, createBnbQuoteCoinGen7, createCoin, createScheduledCoin, req, E, mineAt, buyNative, buyTokens, now, CURVE,
  type Env,
} from "./fixtures/evmgen7Core";

const W = 10n ** 18n;
const MAX = ethers.MaxUint256;

async function pendingCoin(env?: Env) {
  env = env ?? (await deployEvmGen7());
  const { campaign, token } = await createCoin(env, req());
  await mineAt(Number(await campaign.launchAt()) + 61);
  await buyNative(env, campaign, env.alice, E(60)); // sells the curve out
  expect(await campaign.graduationPending()).to.eq(true);
  // native the mock pays out as repair proceeds
  await env.owner.sendTransaction({ to: await env.adapter.getAddress(), value: E(10) });
  return { env, campaign, token };
}

async function plan(campaign: any) {
  const g = await campaign.getGraduationState();
  const R: bigint = g.graduationBalance;
  const P: bigint = g.finalCurvePrice;
  const pool = R - (R * 200n) / 10000n; // gen-7: 2% protocol, 0% creator
  const T = (pool * W) / P;
  const B = (await campaign.totalSupply()) - (await campaign.creatorReserve()) - (await campaign.sold());
  return { R, P, pool, T, B };
}

describe("evmgen7 core C4/C7: repairPool (chunked pre-made pool repair)", function () {
  describe("refusals", function () {
    it("Trading and not due: GraduationNotDue; nothing is approved or called", async () => {
      const env = await deployEvmGen7();
      const { campaign } = await createCoin(env, req());
      await mineAt(Number(await campaign.launchAt()) + 61);
      await expect(campaign.repairPool(0)).to.be.revertedWithCustomError(campaign, "GraduationNotDue");
      expect(await env.adapter.stepCalls()).to.eq(0n);
    });

    it("scheduled coin before launchAt: TradingNotOpen", async () => {
      const env = await deployEvmGen7();
      const { campaign } = await createScheduledCoin(env, req(), (await now()) + 600);
      await expect(campaign.repairPool(0)).to.be.revertedWithCustomError(campaign, "TradingNotOpen");
    });

    it("after graduation: Finalized", async () => {
      const { campaign } = await pendingCoin();
      await campaign.graduate();
      await expect(campaign.repairPool(0)).to.be.revertedWithCustomError(campaign, "Finalized");
    });

    it("pause honoured for 72 h after Pending (same rule as graduate), then ignored", async () => {
      const { env, campaign } = await pendingCoin();
      const since = Number(await campaign.pendingSince());
      await env.factory.setCampaignPauses(await campaign.getAddress(), false, false, false, true);
      await expect(campaign.repairPool(0)).to.be.revertedWithCustomError(campaign, "GraduationPaused");
      await env.factory.setCampaignPauses(await campaign.getAddress(), true, false, false, false);
      await expect(campaign.repairPool(0)).to.be.revertedWithCustomError(campaign, "GraduationPaused");
      await mineAt(since + 72 * 3600);
      await env.adapter.setStep(0, 0, 0, 0, 0);
      await campaign.repairPool(0);
      expect(await env.adapter.stepCalls()).to.eq(1n);
    });

    it("the adapter's report must equal the measured deltas (MEME, proceeds, no native on a quote coin)", async () => {
      const { env, campaign } = await pendingCoin();
      await env.adapter.setStep(E(1000), E(1), 1, 0, 0);
      await expect(campaign.repairPool(0)).to.be.revertedWithCustomError(campaign, "AdapterResultInvalid");
      await env.adapter.setStep(E(1000), E(1), 2, 0, 0);
      await expect(campaign.repairPool(0)).to.be.revertedWithCustomError(campaign, "AdapterResultInvalid");
    });

    it("the adapter cannot take more MEME than the spare (exact allowance)", async () => {
      const { env, campaign } = await pendingCoin();
      const { T, B } = await plan(campaign);
      await env.adapter.setStep(B - T + 1n, 0, 0, 0, 0);
      await expect(campaign.repairPool(0)).to.be.revertedWithCustomError(await ethers.getContractAt("LaunchToken", await campaign.token()), "ERC20InsufficientAllowance");
    });

    it("an adapter re-entering graduate or repairPool hits the guard", async () => {
      const { env, campaign } = await pendingCoin();
      await env.adapter.setStep(0, 0, 0, 1, 0);
      await expect(campaign.repairPool(0)).to.be.revertedWithCustomError(campaign, "ReentrancyGuardReentrantCall");
      await env.adapter.setStep(0, 0, 0, 2, 0);
      await expect(campaign.repairPool(0)).to.be.revertedWithCustomError(campaign, "ReentrancyGuardReentrantCall");
    });
  });

  describe("native coin", function () {
    // Gen-6: "due but not Pending (oracle failed on the crossing buy): repairPool marks Pending and steps". Gen-7 has no
    // oracle trigger, and the sold-out buy always marks Pending, so "due but not Pending" cannot happen on a native
    // coin. Replacement: one token short of sold out is never due for repairPool (whatever the oracle says), and a
    // dead oracle neither blocks the sold-out Pending nor the native repair step.
    it("REPLACED: not due one token short of sold out (raise above the USD target); a dead oracle blocks neither Pending nor a native step", async () => {
      const env = await deployEvmGen7();
      const { campaign } = await createCoin(env, req());
      await mineAt(Number(await campaign.launchAt()) + 61);
      await buyTokens(env, campaign, env.alice, CURVE - E(1));
      const t = await now();
      await env.feed.setRoundData(2, 60_000n * 10n ** 8n, t, t, 2); // the raise is now worth ~13x the $50K target
      await expect(campaign.connect(env.carol).repairPool(0)).to.be.revertedWithCustomError(campaign, "GraduationNotDue");
      expect(await env.adapter.stepCalls()).to.eq(0n);
      const t2 = await now();
      await env.feed.setRoundData(3, 0, t2, t2, 3);
      await buyTokens(env, campaign, env.bob, E(1));
      expect(await campaign.graduationPending()).to.eq(true);
      await expect(campaign.connect(env.carol).repairPool(0)).to.emit(campaign, "PoolRepairStep");
      expect(await env.adapter.stepCalls()).to.eq(1n);
    });

    it("steps sell spare MEME without opening transfers; graduate adds the held native to the pool and conserves the budget", async () => {
      const { env, campaign, token } = await pendingCoin();
      const cAddr = await campaign.getAddress();
      const aAddr = await env.adapter.getAddress();
      const { P, pool, T, B } = await plan(campaign);
      const s1 = (B - T) / 3n;
      const s2 = (B - T) / 5n;

      await env.adapter.setStep(s1, E("0.25"), 0, 0, 0);
      const limit = 123456789n;
      await expect(campaign.connect(env.carol).repairPool(limit))
        .to.emit(campaign, "PoolRepairStep")
        .withArgs(env.carol.address, s1, E("0.25"), s1);
      let r = await env.adapter.lastStepRequest();
      expect(r.token).to.eq(await token.getAddress());
      expect(r.quoteToken).to.eq(ethers.ZeroAddress);
      expect(r.memeTarget).to.eq(T);
      expect(r.memeMax).to.eq(B);
      expect(r.curvePriceWad).to.eq(P);
      expect(r.nativeUsdWad).to.eq(0n);
      expect(await env.adapter.lastStepLimit()).to.eq(limit);
      expect(await token.allowance(cAddr, aAddr)).to.eq(0n);
      // I1 intact: transfers stay closed for holders.
      expect(await token.tradingEnabled()).to.eq(false);
      await expect(token.connect(env.alice).transfer(env.bob.address, 1n)).to.be.revertedWithCustomError(token, "TradingNotEnabled");

      await env.adapter.setStep(s2, E("0.5"), 0, 0, 0);
      await campaign.repairPool(0);
      r = await env.adapter.lastStepRequest();
      expect(r.memeMax).to.eq(B - s1); // the budget shrinks by what earlier steps sold
      expect(r.memeTarget).to.eq(T);
      expect(await campaign.repairMemeSold()).to.eq(s1 + s2);
      expect(await campaign.repairNativeHeld()).to.eq(E("0.75"));
      expect(await campaign.repairQuoteHeld()).to.eq(0n);
      expect(await campaign.excessNativeBalance()).to.eq(0n);

      const supplyBefore = await token.totalSupply();
      await env.adapter.setBehaviour(false, false, 0, 0, 0, 0, false);
      await expect(campaign.graduate()).to.emit(campaign, "Graduated");
      expect(await env.adapter.lastValue()).to.eq(pool + E("0.75"));
      const lr = await env.adapter.lastRequest();
      expect(lr.memeMax).to.eq(B - s1 - s2);
      expect(lr.memeTarget).to.eq(T);
      expect(await campaign.repairNativeHeld()).to.eq(0n);
      const g = await campaign.getGraduationState();
      // memeUsed (this call, T) + repair sold + burned == original budget
      expect(g.graduatedLiquidityTokens).to.eq(T + s1 + s2);
      expect(g.graduatedLiquidityTokens + g.burnedUnsoldTokens).to.eq(B);
      expect(supplyBefore - (await token.totalSupply())).to.eq(g.burnedUnsoldTokens);
      expect(g.graduatedLiquidityBnb).to.eq(pool + E("0.75"));
      expect(await campaign.excessNativeBalance()).to.eq(0n);
      expect(await token.allowance(cAddr, aAddr)).to.eq(0n);
    });

    it("the steps can use up the whole spare; the next step is refused; graduate still meets T", async () => {
      const { env, campaign } = await pendingCoin();
      const { T, B } = await plan(campaign);
      await env.adapter.setStep(MAX, 0, 0, 0, 0);
      await campaign.repairPool(0);
      expect(await campaign.repairMemeSold()).to.eq(B - T);
      await env.adapter.setStep(1, 0, 0, 0, 0);
      // allowance is the spare, now 0
      await expect(campaign.repairPool(0)).to.be.revertedWithCustomError(await ethers.getContractAt("LaunchToken", await campaign.token()), "ERC20InsufficientAllowance");
      await env.adapter.setBehaviour(false, true, 0, 0, 0, 0, false); // pull all that is left (= T)
      await campaign.graduate();
      const g = await campaign.getGraduationState();
      expect(g.graduatedLiquidityTokens).to.eq(B);
      expect(g.burnedUnsoldTokens).to.eq(0n);
    });

    it("graduate: the 1 bp native refund cap is measured against pool native + held proceeds", async () => {
      const { env, campaign } = await pendingCoin();
      const { pool } = await plan(campaign);
      await env.adapter.setStep(E(1000), E(1), 0, 0, 0);
      await campaign.repairPool(0);
      const value = pool + E(1);
      await env.adapter.setBehaviour(false, false, 0, 0, value / 10000n + 1n, 0, false);
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "AdapterResultInvalid");
      await env.adapter.setBehaviour(false, false, 0, 0, value / 10000n, 0, false);
      await campaign.graduate();
      expect((await campaign.getGraduationState()).graduatedLiquidityBnb).to.eq(value - value / 10000n);
    });

    it("a failed graduate after steps keeps the held proceeds and the sold MEME record (retryable)", async () => {
      const { env, campaign } = await pendingCoin();
      await env.adapter.setStep(E(1000), E(1), 0, 0, 0);
      await campaign.repairPool(0);
      await env.adapter.setBehaviour(true, false, 0, 0, 0, 0, false);
      await expect(campaign.graduate()).to.be.revertedWith("adapter down");
      expect(await campaign.repairNativeHeld()).to.eq(E(1));
      expect(await campaign.repairMemeSold()).to.eq(E(1000));
      await env.adapter.setBehaviour(false, false, 0, 0, 0, 0, false);
      await campaign.graduate();
      expect(await campaign.launched()).to.eq(true);
    });
  });

  describe("quote coin (base LaunchCampaignGen7 quote path, via the BNB quote implementation)", function () {
    async function quoteCoin() {
      const q = await deployBnbQuoteGen7();
      const { campaign } = await createBnbQuoteCoinGen7(q, req());
      await mineAt(Number(await campaign.launchAt()) + 61);
      await buyNative(q as any, campaign, q.alice, E(60));
      expect(await campaign.graduationPending()).to.eq(true);
      await q.owner.sendTransaction({ to: await q.quoteAdapter.getAddress(), value: E(1) });
      return { env: q, campaign, qa: q.quoteAdapter, quote: q.quote };
    }

    it("stock-style proceeds are held, approved exactly to the adapter at graduate, pulled back, and never credited to the creator", async () => {
      const { campaign, qa, quote } = await quoteCoin();
      const cAddr = await campaign.getAddress();
      const qaAddr = await qa.getAddress();
      await qa.setStep(E(5000), E(7), 0, 0, 0);
      await campaign.repairPool(0);
      const r = await qa.lastStepRequest();
      expect(r.quoteToken).to.eq(await quote.getAddress());
      expect(r.nativeUsdWad).to.eq(600n * W); // same request as graduate(): oracle price on quote paths
      expect(await campaign.repairQuoteHeld()).to.eq(E(7));
      expect(await campaign.repairNativeHeld()).to.eq(0n);
      expect(await quote.balanceOf(cAddr)).to.eq(E(7));

      await qa.setQuote(E(2), 2); // the adapter also returns a residual of 2
      const { pool } = await plan(campaign);
      await campaign.graduate();
      expect(await qa.lastValue()).to.eq(pool); // no native proceeds on a quote coin
      expect(await campaign.repairQuoteHeld()).to.eq(0n);
      expect(await quote.allowance(cAddr, qaAddr)).to.eq(0n);
      expect(await campaign.pendingCreatorQuote()).to.eq(E(2)); // residual only, not the pulled 7
      expect(await quote.balanceOf(cAddr)).to.eq(E(2));
    });

    it("an adapter that pulls more quote than the held proceeds reverts the graduation", async () => {
      const { campaign, qa, quote } = await quoteCoin();
      await qa.setStep(E(5000), E(7), 0, 0, 1);
      await campaign.repairPool(0);
      await expect(campaign.graduate()).to.be.revertedWithCustomError(quote, "ERC20InsufficientAllowance");
      expect(await campaign.graduationPending()).to.eq(true);
    });

    it("native arriving during a quote-coin step is refused", async () => {
      const { campaign, qa } = await quoteCoin();
      await qa.setStep(E(5000), E(7), 3, 0, 0);
      await expect(campaign.repairPool(0)).to.be.revertedWithCustomError(campaign, "AdapterResultInvalid");
    });
  });
});
