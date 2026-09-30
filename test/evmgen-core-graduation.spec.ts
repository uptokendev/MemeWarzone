import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployEvmGen,
  createCoin,
  req,
  E,
  area,
  mineAt,
  buyTokens,
  buyNative,
  sellTokens,
  signCreate,
  now,
  increaseTime,
  DAY,
  FEE_HOLDERS,
  FEE_SPLIT,
  FEE_KEEP,
  type Env,
} from "./fixtures/evmgenCore";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";

const W = 10n ** 18n;

async function tradingCoin(env?: Env, r = req()) {
  env = env ?? (await deployEvmGen());
  const { campaign, token } = await createCoin(env, r);
  await mineAt(Number(await campaign.launchAt()) + 61);
  return { env, campaign, token };
}

/** Crosses the $30K target (50 BNB at $600) with one buy. */
async function toPending(env: Env, campaign: any) {
  const tx = await buyNative(env, campaign, env.alice, E(60));
  return tx;
}

async function expectedSplit(campaign: any) {
  const g = await campaign.getGraduationState();
  const R: bigint = g.graduationBalance;
  const P: bigint = g.finalCurvePrice;
  const protocol = (R * 220n) / 10000n;
  const creator = (R * 1980n) / 10000n;
  const pool = R - protocol - creator;
  const T = (pool * W) / P;
  const budget = (await campaign.totalSupply()) - (await campaign.creatorReserve()) - (await campaign.sold());
  return { R, P, protocol, creator, pool, T, budget };
}

describe("evmgen core C5: graduation", function () {
  describe("entering Pending", function () {
    it("the crossing buy only marks Pending: no router finalize, no adapter call, trading frozen", async () => {
      const { env, campaign, token } = await tradingCoin();
      await buyTokens(env, campaign, env.bob, E(1_000_000));
      await env.adapter.setBehaviour(true, false, 0, 0, 0, 0, false); // adapter down
      const tx = await toPending(env, campaign);
      await expect(tx).to.emit(campaign, "GraduationPending");
      expect(await campaign.graduationPending()).to.eq(true);
      expect(await campaign.pendingTrigger()).to.eq(0);
      expect(await env.adapter.calls()).to.eq(0n);
      expect(await env.evmRouter.finalizeCalls()).to.eq(0n);
      const g = await campaign.getGraduationState();
      expect(g.graduationBalance).to.eq(await campaign.netRaisedWei());
      expect(g.finalCurvePrice).to.eq(await campaign.currentPrice());
      await expect(buyTokens(env, campaign, env.bob, E(1000))).to.be.revertedWithCustomError(campaign, "GraduationIsPending");
      await expect(sellTokens(env, campaign, token, env.bob, E(1000))).to.be.revertedWithCustomError(campaign, "GraduationIsPending");
      // adapter down: graduate reverts, Pending stays, anyone retries later
      await expect(campaign.connect(env.carol).graduate()).to.be.revertedWith("adapter down");
      expect(await campaign.graduationPending()).to.eq(true);
      await env.adapter.setBehaviour(false, false, 0, 0, 0, 0, false);
      await campaign.connect(env.carol).graduate();
      expect(await campaign.launched()).to.eq(true);
      expect(await campaign.graduationPending()).to.eq(false);
    });

    it("graduate() while not due reverts GraduationNotDue", async () => {
      const { campaign } = await tradingCoin();
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "GraduationNotDue");
    });

    it("an oracle revert on the crossing buy leaves Trading; graduate() later marks and graduates in one call", async () => {
      const { env, campaign } = await tradingCoin();
      const t = await now();
      await env.feed.setRoundData(2, 0, t, t, 2); // oracle reverts InvalidPrice
      await toPending(env, campaign);
      expect(await campaign.graduationPending()).to.eq(false);
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "GraduationNotDue");
      const t2 = await now();
      await env.feed.setRoundData(3, 600n * 10n ** 8n, t2, t2, 3);
      await expect(campaign.connect(env.carol).graduate()).to.emit(campaign, "GraduationPending").and.to.emit(campaign, "Graduated");
    });

    it("sold out graduates below the USD target (trigger 1, no oracle needed)", async () => {
      const { env, campaign } = await tradingCoin();
      const t = await now();
      await env.feed.setRoundData(2, 50n * 10n ** 8n, t, t, 2); // $30K is now 600 BNB > the whole curve
      const remaining = await campaign.curveSupply();
      await buyTokens(env, campaign, env.alice, remaining);
      expect(await campaign.graduationPending()).to.eq(true);
      expect(await campaign.pendingTrigger()).to.eq(1);
      // oracle broken afterwards: the native path does not need it
      const t2 = await now();
      await env.feed.setRoundData(3, 0, t2, t2, 3);
      const s = await expectedSplit(campaign);
      expect(s.budget).to.eq(await campaign.liquiditySupply());
      expect(s.T <= s.budget).to.eq(true);
      await campaign.graduate();
      expect(await campaign.launched()).to.eq(true);
    });

    it("pause is honoured for 72 h after Pending, then ignored", async () => {
      const { env, campaign } = await tradingCoin();
      await toPending(env, campaign);
      const since = Number(await campaign.pendingSince());
      await env.factory.setCampaignPauses(await campaign.getAddress(), false, false, false, true);
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "GraduationPaused");
      await mineAt(since + 72 * 3600 - 2);
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "GraduationPaused");
      await mineAt(since + 72 * 3600);
      await campaign.graduate();
      expect(await campaign.launched()).to.eq(true);
    });
  });

  describe("split and pool", function () {
    it("exact 2.2 / 19.8 / 78 with the dust to the pool, profile, pool tokens = poolNative / P, burn and conservation", async () => {
      const { env, campaign, token } = await tradingCoin(undefined, req({ graduationTarget: E(15_000) }));
      await buyTokens(env, campaign, env.bob, E(3_333_333));
      await buyNative(env, campaign, env.alice, E(30));
      expect(await campaign.graduationPending()).to.eq(true);
      const s = await expectedSplit(campaign);
      expect(s.protocol + s.creator + s.pool).to.eq(s.R);
      const supply = await campaign.totalSupply();
      const reserve = await campaign.creatorReserve();
      const sold = await campaign.sold();
      const tx = await campaign.connect(env.carol).graduate();
      const lr = await env.adapter.lastRequest();
      expect(await env.adapter.lastValue()).to.eq(s.pool);
      expect(lr.memeTarget).to.eq(s.T);
      expect(lr.memeMax).to.eq(s.budget);
      expect(lr.curvePriceWad).to.eq(s.P);
      expect(lr.nativeUsdWad).to.eq(0n);
      expect(lr.quoteToken).to.eq(ethers.ZeroAddress);
      expect(await env.evmRouter.finalizeTotal()).to.eq(s.protocol);
      expect(await env.evmRouter.lastFinalizeProfile()).to.eq(await campaign.finalizeRouteProfile());
      expect(await campaign.pendingCreatorGraduation()).to.eq(s.creator);
      expect(await campaign.creatorGraduationBeneficiary()).to.eq(env.creator.address);
      const g = await campaign.getGraduationState();
      const burned = s.budget - s.T;
      expect(g.graduatedLiquidityTokens).to.eq(s.T);
      expect(g.burnedUnsoldTokens).to.eq(burned);
      expect(g.graduatedLiquidityBnb).to.eq(s.pool);
      // invariant 2: sold + memeUsed + burned + reserve == totalSupply
      expect(sold + s.T + burned + reserve).to.eq(supply);
      expect(await token.totalSupply()).to.eq(supply - burned);
      expect(g.postBurnTotalSupply).to.eq(supply - burned);
      expect(await token.balanceOf(env.creator.address)).to.eq(reserve);
      expect(await token.balanceOf(await campaign.getAddress())).to.eq(0n);
      expect(await token.tradingEnabled()).to.eq(true);
      expect(await token.allowance(await campaign.getAddress(), await env.adapter.getAddress())).to.eq(0n);
      // native: campaign keeps exactly the creator's pull balance
      expect(await ethers.provider.getBalance(await campaign.getAddress())).to.eq(s.creator);
      await expect(tx).to.emit(campaign, "Graduated").withArgs(g.dexPair, s.R, s.protocol, s.creator, s.pool, s.T, burned, s.P, s.P, false);
      await expect(tx).to.emit(env.factory, "CampaignGraduated");
      const info = await env.locker.poolInfo(g.dexPair);
      expect(info.registered).to.eq(true);
      expect(info.creator).to.eq(env.creator.address);
      expect(info.creatorFeeRecipient).to.eq(env.creator.address);
      // graduated: trading on the curve is over
      await expect(buyTokens(env, campaign, env.bob, 1n)).to.be.revertedWithCustomError(campaign, "Finalized");
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "Finalized");
    });

    it("split fuzz: protocol + creator + pool == R and T == floor(pool*1e18/P) over random raises", async () => {
      for (const [bob, crossing] of [
        [E(1), E(52)],
        [E(7_777_777), E(55)],
        [E(123_456_789), E(70)],
      ] as Array<[bigint, bigint]>) {
        const { env, campaign } = await tradingCoin();
        await buyTokens(env, campaign, env.bob, bob);
        await buyNative(env, campaign, env.alice, crossing);
        const s = await expectedSplit(campaign);
        await campaign.graduate();
        expect(await env.adapter.lastValue()).to.eq(s.pool);
        expect((await env.adapter.lastRequest()).memeTarget).to.eq(s.T);
        expect(s.protocol + s.creator + s.pool).to.eq(s.R);
        expect(s.pool - (s.R * 7800n) / 10000n <= 2n).to.eq(true);
      }
    });

    it("start price band: below always reverts; above reverts unless the budget was exhausted", async () => {
      const { env, campaign } = await tradingCoin();
      await toPending(env, campaign);
      await env.adapter.setBehaviour(false, false, 0, 0, 0, 51, true);
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "StartPriceOutOfBand");
      await env.adapter.setBehaviour(false, false, 0, 0, 0, 50, true);
      await env.adapter.setBehaviour(false, false, 0, 0, 0, 51, false);
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "StartPriceOutOfBand");
      // budget exhausted (repair used every spare token): a higher start price is accepted
      await env.adapter.setBehaviour(false, true, 0, 0, 0, 900, false);
      await campaign.graduate();
      const g = await campaign.getGraduationState();
      expect(g.burnedUnsoldTokens).to.eq(0n);
    });

    it("adapter result checks: fewer tokens than the target, a lying result, and a >1 bp refund revert", async () => {
      const { env, campaign } = await tradingCoin();
      await toPending(env, campaign);
      await env.adapter.setBehaviour(false, false, 0, 1, 0, 0, false);
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "AdapterResultInvalid");
      await env.adapter.setBehaviour(false, false, 0, 0, 0, 0, false);
      await env.adapter.setLie(true);
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "AdapterResultInvalid");
      await env.adapter.setLie(false);
      const s = await expectedSplit(campaign);
      const oneBp = s.pool / 10000n;
      await env.owner.sendTransaction({ to: await env.adapter.getAddress(), value: E(1) });
      await env.adapter.setBehaviour(false, false, 0, 0, oneBp + 1n, 0, false);
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "AdapterResultInvalid");
      // exactly 1 bp is accepted and goes to the creator's pull balance
      await env.adapter.setBehaviour(false, false, 0, 0, oneBp, 0, false);
      await campaign.graduate();
      expect(await campaign.pendingCreatorGraduation()).to.eq(s.creator + oneBp);
    });

    it("a budget-exhausting repair may return more native; it is credited to the creator, never stuck", async () => {
      const { env, campaign } = await tradingCoin();
      await toPending(env, campaign);
      const s = await expectedSplit(campaign);
      await env.owner.sendTransaction({ to: await env.adapter.getAddress(), value: E(5) });
      await env.adapter.setBehaviour(false, true, 0, 0, E(1), 0, false);
      await campaign.graduate();
      expect(await campaign.pendingCreatorGraduation()).to.eq(s.creator + E(1));
      expect(await campaign.excessNativeBalance()).to.eq(0n);
    });

    it("an adapter re-entering graduate() is stopped by the guard and Pending survives", async () => {
      const { env, campaign } = await tradingCoin();
      await toPending(env, campaign);
      await env.adapter.setReenter(true);
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "ReentrancyGuardReentrantCall");
      expect(await campaign.graduationPending()).to.eq(true);
      expect(await campaign.launched()).to.eq(false);
      await env.adapter.setReenter(false);
      await campaign.graduate();
    });
  });

  describe("protocol share and creator claim", function () {
    it("a reverting router escrows the protocol share; flush is permissionless and pays once the router works", async () => {
      const { env, campaign } = await tradingCoin();
      await toPending(env, campaign);
      await env.evmRouter.setReverts(false, true);
      const s = await expectedSplit(campaign);
      await expect(campaign.graduate()).to.emit(campaign, "ProtocolGraduationFeeEscrowed").withArgs(s.protocol);
      expect(await campaign.pendingProtocolGraduationFee()).to.eq(s.protocol);
      await expect(campaign.connect(env.carol).flushProtocolGraduationFee()).to.be.revertedWith("finalize paused");
      expect(await campaign.pendingProtocolGraduationFee()).to.eq(s.protocol);
      // rescue can never reach it
      await env.owner.sendTransaction({ to: await campaign.getAddress(), value: E(1) });
      expect(await campaign.excessNativeBalance()).to.eq(E(1));
      await expect(campaign.connect(env.creator).rescueExcessNative(env.creator.address, E(1) + 1n)).to.be.revertedWithCustomError(campaign, "ExcessNativeUnavailable");
      await campaign.connect(env.creator).rescueExcessNative(env.creator.address, E(1));
      await env.evmRouter.setReverts(false, false);
      await expect(campaign.connect(env.carol).flushProtocolGraduationFee()).to.emit(campaign, "ProtocolGraduationFeeFlushed").withArgs(s.protocol);
      expect(await env.evmRouter.finalizeTotal()).to.eq(s.protocol);
      await expect(campaign.flushProtocolGraduationFee()).to.be.revertedWithCustomError(campaign, "NothingToClaim");
      // invariant 7: what is left is exactly the creator's pull balance
      expect(await ethers.provider.getBalance(await campaign.getAddress())).to.eq(await campaign.pendingCreatorGraduation());
    });

    it("a creator wallet that rejects native still graduates, then claims to another address", async () => {
      const env = await deployEvmGen();
      const wallet = await (await ethers.getContractFactory("MockCreatorWalletEvmGen")).deploy();
      const r = req();
      const auth = await signCreate(env.authority, await env.factory.getAddress(), await wallet.getAddress(), r);
      await wallet.execute(await env.factory.getAddress(), 0, env.factory.interface.encodeFunctionData("createCampaignAuthorized", [r, auth]));
      const campaign = await ethers.getContractAt("LaunchCampaign", (await env.factory.getCampaign(0)).campaign);
      await mineAt(Number(await campaign.launchAt()) + 61);
      await toPending(env, campaign);
      const s = await expectedSplit(campaign);
      await campaign.connect(env.carol).graduate();
      expect(await campaign.creatorGraduationBeneficiary()).to.eq(await wallet.getAddress());
      const claim = (to: string) => campaign.interface.encodeFunctionData("claimCreatorGraduation", [to, false]);
      await expect(wallet.execute(await campaign.getAddress(), 0, claim(await wallet.getAddress()))).to.be.revertedWithCustomError(campaign, "NativeTransferFailed");
      expect(await campaign.pendingCreatorGraduation()).to.eq(s.creator);
      await expect(campaign.connect(env.alice).claimCreatorGraduation(env.alice.address, false)).to.be.revertedWithCustomError(campaign, "NotBeneficiary");
      const before = await ethers.provider.getBalance(env.bob.address);
      await wallet.execute(await campaign.getAddress(), 0, claim(env.bob.address));
      expect(await ethers.provider.getBalance(env.bob.address)).to.eq(before + s.creator);
      await expect(wallet.execute(await campaign.getAddress(), 0, claim(env.bob.address))).to.be.revertedWithCustomError(campaign, "NothingToClaim");
    });

    it("the beneficiary is the owner at graduation, and escrow claims keep working after graduation", async () => {
      const { env, campaign, token } = await tradingCoin();
      const tx = await buyTokens(env, campaign, env.creator, E(2_000_000));
      const at = (await ethers.provider.getBlock(tx.blockNumber!))!.timestamp;
      await campaign.connect(env.creator).transferOwnership(env.bob.address);
      await toPending(env, campaign);
      await campaign.graduate();
      expect(await campaign.creatorGraduationBeneficiary()).to.eq(env.bob.address);
      await expect(campaign.connect(env.creator).claimCreatorGraduation(env.creator.address, false)).to.be.revertedWithCustomError(campaign, "NotBeneficiary");
      await campaign.connect(env.bob).claimCreatorGraduation(env.bob.address, true);
      await mineAt(at + 58 * DAY);
      await campaign.connect(env.creator).claimCreatorEscrow();
      expect(await token.balanceOf(env.creator.address)).to.eq(E(2_000_000));
      // escrowed tokens survived graduation (never burned or pooled)
      expect(await campaign.creatorEscrowTotal()).to.eq(E(2_000_000));
    });

    it("rescue before graduation is refused; after, only donations are rescuable", async () => {
      const { env, campaign } = await tradingCoin();
      await env.owner.sendTransaction({ to: await campaign.getAddress(), value: E(2) });
      expect(await campaign.excessNativeBalance()).to.eq(0n);
      await expect(campaign.connect(env.creator).rescueExcessNative(env.creator.address, 1n)).to.be.revertedWithCustomError(campaign, "NotFinalized");
      await toPending(env, campaign);
      await campaign.graduate();
      expect(await campaign.excessNativeBalance()).to.eq(E(2));
      await expect(campaign.connect(env.alice).rescueExcessNative(env.alice.address, 1n)).to.be.revertedWithCustomError(campaign, "OwnableUnauthorizedAccount");
    });
  });

  describe("fee choice (E10/D19)", function () {
    for (const [choice, pct] of [
      [FEE_HOLDERS, 0],
      [FEE_SPLIT, 40],
    ]) {
      it(`choice ${choice}: the vault holds the choice, the locker keys the pool by campaign and pays the vault`, async () => {
        const env = await deployEvmGen();
        const { campaign } = await tradingCoin(env, req({ feeChoice: choice, feeCreatorPct: pct }));
        const c = await campaign.getAddress();
        const cfg = await env.vault.cfg(c);
        expect(cfg.choice).to.eq(choice);
        expect(cfg.creatorPct).to.eq(pct);
        expect(cfg.creator).to.eq(env.creator.address);
        const fc = await env.factory.campaignFeeChoice(c);
        expect(fc.vault).to.eq(await env.vault.getAddress());
        expect(fc.choice).to.eq(choice);
        await toPending(env, campaign);
        await campaign.graduate();
        const info = await env.locker.poolInfo((await campaign.getGraduationState()).dexPair);
        expect(info.creator).to.eq(c);
        expect(info.creatorFeeRecipient).to.eq(await env.vault.getAddress());
        expect(info.campaign).to.eq(c);
      });
    }

    it("invalid choices are refused before anything is created", async () => {
      const env = await deployEvmGen();
      for (const [choice, pct] of [
        [0, 0],
        [5, 0],
        [FEE_SPLIT, 0],
        [FEE_SPLIT, 100],
        [FEE_KEEP, 10],
        [FEE_HOLDERS, 1],
      ]) {
        await expect(createCoin(env, req({ feeChoice: choice, feeCreatorPct: pct }))).to.be.revertedWithCustomError(env.factory, "InvalidFeeChoice");
      }
      await env.evmRouter.setCreatorRewardsVault(ethers.ZeroAddress);
      await expect(createCoin(env, req())).to.be.revertedWithCustomError(env.factory, "CreatorVaultUnavailable");
    });
  });

  describe("supply bound (C5 §2)", function () {
    it("setConfig refuses today's 8400/1400/850 and accepts the new curves; create refuses an out-of-range target", async () => {
      const [owner] = await ethers.getSigners();
      const env = await deployEvmGen({ nativeUsd: 100 });
      void owner;
      const fresh = await (await deployFactoryWithLocker({ factoryName: "LaunchFactory", args: [await env.topazRouter.getAddress(),
        await env.evmRouter.getAddress(),
        await env.impl.getAddress(),
        await env.oracle.getAddress()] })).factory;
      const cfg = await fresh.config();
      expect(cfg.curveBps).to.eq(7000n);
      expect(cfg.liquidityTokenBps).to.eq(2800n);
      expect(cfg.priceSlope).to.eq(1080n); // Topaz V2 = BNB
      const base = { totalSupply: E(1_000_000_000), basePrice: 1_000_000_000n, graduationTarget: E(30_000) };
      await expect(fresh.setConfig({ ...base, curveBps: 8400, liquidityTokenBps: 1400, priceSlope: 850 })).to.be.revertedWithCustomError(fresh, "SupplyBoundBroken");
      await fresh.setConfig({ ...base, curveBps: 7000, liquidityTokenBps: 2800, priceSlope: 850 });
      await fresh.setConfig({ ...base, curveBps: 7000, liquidityTokenBps: 2800, priceSlope: 1080 });
      // the exact boundary: at 8400 curve, 7040 still fits a large enough liquidity share? find a failing one
      await expect(fresh.setConfig({ ...base, curveBps: 7100, liquidityTokenBps: 2700, priceSlope: 1080 })).to.be.revertedWithCustomError(fresh, "SupplyBoundBroken");
      await expect(fresh.setConfig({ ...base, curveBps: 7000, liquidityTokenBps: 2800, priceSlope: 10n ** 22n + 1n })).to.be.revertedWithCustomError(fresh, "ParamTooHigh");

      // BNB $100: $50K = 500 BNB > 95% of A(700M) = 252 BNB -> refused; $15K = 150 BNB fits
      await expect(createCoin(env, req({ graduationTarget: E(50_000) }))).to.be.revertedWithCustomError(env.factory, "TargetOutOfRangeAtPrice");
      await createCoin(env, req({ graduationTarget: E(15_000) }));
    });

    it("fuzz: every curve setConfig accepts graduates within its budget at every sold level", async () => {
      const W18 = 10n ** 18n;
      for (const [k, curveBps, liqBps] of [
        [1080n, 7000n, 2800n],
        [850n, 7000n, 2800n],
      ]) {
        const supply = E(1_000_000_000);
        const curve = (supply * curveBps) / 10000n;
        const liq = (supply * liqBps) / 10000n;
        for (let i = 1n; i <= 40n; i++) {
          const s = (curve * i) / 40n;
          const R = area(s, 1_000_000_000n, k);
          const pool = R - (R * 220n) / 10000n - (R * 1980n) / 10000n;
          const P = 1_000_000_000n + (k * s) / W18;
          const T = (pool * W18) / P;
          expect(T <= curve - s + liq, `k=${k} s=${s}`).to.eq(true);
        }
      }
    });
  });

  it("paused-by-default direct trading is the Safe's exit: unsigned entry points open only when turned off", async () => {
    const { env, campaign, token } = await tradingCoin();
    await expect(campaign.connect(env.alice).buyExactTokens(E(1), E(1), { value: E(1) })).to.be.revertedWithCustomError(campaign, "AuthorizedTradingRequired");
    await env.factory.setCampaignRequireAuthorizedTrading(await campaign.getAddress(), false);
    const cost = await campaign.quoteBuyExactTokens(E(1_000));
    await campaign.connect(env.alice).buyExactTokens(E(1_000), cost, { value: cost });
    await token.connect(env.alice).approve(await campaign.getAddress(), E(1_000));
    await campaign.connect(env.alice).sellExactTokens(E(1_000), 0n);
    await campaign.connect(env.alice).buyExactBnb(0n, { value: E(1) });
    void increaseTime;
  });
});
