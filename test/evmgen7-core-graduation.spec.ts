import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployEvmGen7,
  createCoin,
  req,
  E,
  area,
  curveForMarketCap,
  curveNative,
  priceAt,
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
  SUPPLY,
  CURVE,
  POOL,
  type Env,
} from "./fixtures/evmgen7Core";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";

const W = 10n ** 18n;

async function tradingCoin(env?: Env, r = req()) {
  env = env ?? (await deployEvmGen7());
  const { campaign, token } = await createCoin(env, r);
  await mineAt(Number(await campaign.launchAt()) + 61);
  return { env, campaign, token };
}

/** Gen-7: sells out the curve with one buy (the $50K curve at $600 raises ~11 BNB; the rest is refunded). */
async function toPending(env: Env, campaign: any) {
  const tx = await buyNative(env, campaign, env.alice, E(60));
  return tx;
}

/** Gen-7 split: 2% protocol, 0% creator, 98% pool. */
async function expectedSplit(campaign: any) {
  const g = await campaign.getGraduationState();
  const R: bigint = g.graduationBalance;
  const P: bigint = g.finalCurvePrice;
  const protocol = (R * 200n) / 10000n;
  const creator = 0n;
  const pool = R - protocol - creator;
  const T = (pool * W) / P;
  const budget = (await campaign.totalSupply()) - (await campaign.creatorReserve()) - (await campaign.sold());
  return { R, P, protocol, creator, pool, T, budget };
}

describe("evmgen7 core C4: graduation", function () {
  describe("entering Pending", function () {
    it("the sold-out buy only marks Pending: no router finalize, no adapter call, trading frozen", async () => {
      const { env, campaign, token } = await tradingCoin();
      await buyTokens(env, campaign, env.bob, E(1_000_000));
      await env.adapter.setBehaviour(true, false, 0, 0, 0, 0, false); // adapter down
      const tx = await toPending(env, campaign);
      await expect(tx).to.emit(campaign, "GraduationPending");
      expect(await campaign.graduationPending()).to.eq(true);
      expect(await campaign.sold()).to.eq(await campaign.curveSupply());
      expect(await campaign.pendingTrigger()).to.eq(1); // gen-7: sold out is the only trigger
      expect(await env.adapter.calls()).to.eq(0n);
      expect(await env.evmRouter.finalizeCalls()).to.eq(0n);
      const g = await campaign.getGraduationState();
      expect(g.graduationBalance).to.eq(await campaign.netRaisedWei());
      expect(g.finalCurvePrice).to.eq(await campaign.currentPrice());
      // explicit maxCost: the quote view itself refuses (SoldOut) once sold == curveSupply; the trade refuses on state first
      await expect(buyTokens(env, campaign, env.bob, E(1000), E(1))).to.be.revertedWithCustomError(campaign, "GraduationIsPending");
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

    // Gen-6: "an oracle revert on the crossing buy leaves Trading; graduate() later marks and graduates". Gen-7 reads
    // no oracle on buys, so the replacement pins both halves of that: a raise worth more than the USD target never
    // triggers, and a dead oracle never blocks the sold-out trigger.
    it("REPLACED: no oracle trigger: a raise above the USD target is not due until sold out; a dead oracle cannot stop the sold-out buy", async () => {
      const { env, campaign } = await tradingCoin();
      const target0 = await campaign.graduationNativeTarget();
      await buyTokens(env, campaign, env.alice, CURVE - E(1));
      // Native x100 ($60,000): the $50K target is now ~0.83 BNB, the raise is ~11 BNB. Gen-6 would graduate here.
      const t = await now();
      await env.feed.setRoundData(2, 60_000n * 10n ** 8n, t, t, 2);
      expect((await campaign.netRaisedWei()) > (await env.oracle.nativeTargetForUsd(E(50_000)))).to.eq(true);
      expect(await campaign.graduationNativeTarget()).to.eq(target0); // fixed by the curve, not the oracle
      expect(await campaign.graduationPending()).to.eq(false);
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "GraduationNotDue");
      // a sell keeps it in Trading too
      await sellTokens(env, campaign, (await ethers.getContractAt("LaunchToken", await campaign.token())), env.alice, E(1));
      expect(await campaign.graduationPending()).to.eq(false);
      // oracle dead: the last tokens still sell out and enter Pending; the native graduation never reads it
      const t2 = await now();
      await env.feed.setRoundData(3, 0, t2, t2, 3);
      await expect(buyTokens(env, campaign, env.bob, E(2))).to.emit(campaign, "GraduationPending");
      expect(await campaign.pendingTrigger()).to.eq(1);
      await expect(campaign.connect(env.carol).graduate()).to.emit(campaign, "Graduated");
    });

    it("sold out graduates below the USD target (trigger 1, no oracle needed)", async () => {
      const { env, campaign } = await tradingCoin();
      const t = await now();
      await env.feed.setRoundData(2, 50n * 10n ** 8n, t, t, 2); // native falls to $50: the raise is now far below $50K
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
    it("exact 2 / 0 / 98 with the dust to the pool, profile, pool tokens = poolNative / P, burn and conservation", async () => {
      // gen-6 used the $15K target, which gen-7 no longer allows; $30K is the smallest live target.
      const { env, campaign, token } = await tradingCoin(undefined, req({ graduationTarget: E(30_000) }));
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
      expect(await campaign.pendingCreatorGraduation()).to.eq(0n);
      expect(await campaign.creatorGraduationBeneficiary()).to.eq(env.creator.address);
      const g = await campaign.getGraduationState();
      const burned = s.budget - s.T;
      expect(g.graduatedLiquidityTokens).to.eq(s.T);
      expect(g.burnedUnsoldTokens).to.eq(burned);
      expect(burned > 0n).to.eq(true); // gen-7: the 0.01% pool margin is burned
      expect(g.graduatedLiquidityBnb).to.eq(s.pool);
      // invariant 2: sold + memeUsed + burned + reserve == totalSupply
      expect(sold + s.T + burned + reserve).to.eq(supply);
      expect(await token.totalSupply()).to.eq(supply - burned);
      expect(g.postBurnTotalSupply).to.eq(supply - burned);
      expect(await token.balanceOf(env.creator.address)).to.eq(reserve);
      expect(await token.balanceOf(await campaign.getAddress())).to.eq(0n);
      expect(await token.tradingEnabled()).to.eq(true);
      expect(await token.allowance(await campaign.getAddress(), await env.adapter.getAddress())).to.eq(0n);
      // native: campaign keeps exactly the creator's pull balance (0 in gen-7)
      expect(await ethers.provider.getBalance(await campaign.getAddress())).to.eq(s.creator);
      await expect(tx).to.emit(campaign, "Graduated").withArgs(g.dexPair, s.R, s.protocol, s.creator, s.pool, s.T, burned, s.P, s.P, false);
      await expect(tx).to.emit(env.factory, "CampaignGraduated");
      const info = await env.locker.poolInfo(g.dexPair);
      expect(info.registered).to.eq(true);
      expect(info.creator).to.eq(env.creator.address);
      expect(info.creatorFeeRecipient).to.eq(env.creator.address);
      // graduated: trading on the curve is over
      await expect(buyTokens(env, campaign, env.bob, 1n, E(1))).to.be.revertedWithCustomError(campaign, "Finalized");
      await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "Finalized");
    });

    // Gen-6 varied the crossing buy to vary R. In gen-7 R is fixed per curve (Y(curve) - Y(0)), so R varies with the
    // target and the native price at create instead; the pre-buy still varies the path.
    it("split fuzz: protocol + creator + pool == R and T == floor(pool*1e18/P) over curves (target x native price)", async () => {
      for (const [targetUsd, nativeUsd, bob] of [
        [30_000, 600, E(1)],
        [50_000, 3_000, E(7_777_777)],
        [50_000, 25, E(123_456_789)], // signers hold 10k native: the low-price curves stay affordable
        [30_000, 250, E(400_000_000)],
      ] as Array<[number, number, bigint]>) {
        const env = await deployEvmGen7({ nativeUsd });
        const { campaign } = await tradingCoin(env, req({ graduationTarget: E(targetUsd) }));
        const vNative = BigInt(await campaign.virtualNative());
        const vToken = BigInt(await campaign.virtualToken());
        await buyTokens(env, campaign, env.bob, bob);
        await buyTokens(env, campaign, env.alice, CURVE - bob);
        const s = await expectedSplit(campaign);
        expect(s.R).to.eq(curveNative(CURVE, vNative, vToken) - curveNative(0n, vNative, vToken));
        await campaign.graduate();
        expect(await env.adapter.lastValue()).to.eq(s.pool);
        expect((await env.adapter.lastRequest()).memeTarget).to.eq(s.T);
        expect(s.protocol + s.creator + s.pool).to.eq(s.R);
        expect(s.pool - (s.R * 9800n) / 10000n <= 2n).to.eq(true);
        expect(s.T <= POOL).to.eq(true);
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
      // exactly 1 bp is accepted and goes to the creator's pull balance (gen-7: the only native it ever holds)
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

    // Gen-6 claimed the 19.8% share. Gen-7 has no creator share, so the pull balance is fed by a 1 bp adapter refund
    // (the only native it can receive) to keep the property: a rejecting wallet graduates and claims elsewhere.
    it("a creator wallet that rejects native still graduates, then claims its residual to another address", async () => {
      const env = await deployEvmGen7();
      const wallet = await (await ethers.getContractFactory("MockCreatorWalletEvmGen")).deploy();
      const r = req();
      const auth = await signCreate(env.authority, await env.factory.getAddress(), await wallet.getAddress(), r);
      await wallet.execute(await env.factory.getAddress(), 0, env.factory.interface.encodeFunctionData("createCampaignAuthorized", [r, auth]));
      const campaign = await ethers.getContractAt("LaunchCampaignGen7", (await env.factory.getCampaign(0)).campaign);
      await mineAt(Number(await campaign.launchAt()) + 61);
      await toPending(env, campaign);
      const s = await expectedSplit(campaign);
      const refund = s.pool / 10000n;
      await env.owner.sendTransaction({ to: await env.adapter.getAddress(), value: E(1) });
      await env.adapter.setBehaviour(false, false, 0, 0, refund, 0, false);
      await campaign.connect(env.carol).graduate();
      expect(await campaign.creatorGraduationBeneficiary()).to.eq(await wallet.getAddress());
      const claim = (to: string) => campaign.interface.encodeFunctionData("claimCreatorGraduation", [to, false]);
      await expect(wallet.execute(await campaign.getAddress(), 0, claim(await wallet.getAddress()))).to.be.revertedWithCustomError(campaign, "NativeTransferFailed");
      expect(await campaign.pendingCreatorGraduation()).to.eq(s.creator + refund);
      await expect(campaign.connect(env.alice).claimCreatorGraduation(env.alice.address, false)).to.be.revertedWithCustomError(campaign, "NotBeneficiary");
      const before = await ethers.provider.getBalance(env.bob.address);
      await wallet.execute(await campaign.getAddress(), 0, claim(env.bob.address));
      expect(await ethers.provider.getBalance(env.bob.address)).to.eq(before + s.creator + refund);
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
      // gen-7: no creator share, so the beneficiary has nothing to claim (gen-6 claimed 19.8% here)
      await expect(campaign.connect(env.bob).claimCreatorGraduation(env.bob.address, true)).to.be.revertedWithCustomError(campaign, "NothingToClaim");
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
        const env = await deployEvmGen7();
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
      const env = await deployEvmGen7();
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

  // Gen-6 C5 §2 checked a factory-wide linear curve (base/slope) against the 28% budget and refused targets above
  // 95% of the curve at the oracle price. Gen-7 sizes each coin's curve from its target, so the bound becomes:
  // setConfig refuses any split whose pool cannot fit (r >= 1 / empty pool), create refuses a market cap outside the
  // factory's native range, and every sized curve's graduation fits its 13% pool.
  describe("supply bound (gen-7 C8)", function () {
    it("REPLACED: setConfig accepts 8500/1300 and refuses a pool that cannot fit; create refuses a market cap below MIN_MARKET_CAP_NATIVE at the oracle price", async () => {
      const env = await deployEvmGen7({ nativeUsd: 40_000_000 }); // $50K = 1.25e15 wei, $30K = 7.5e14 wei
      const fresh = await (await deployFactoryWithLocker({ factoryName: "LaunchFactoryGen7", args: [await env.topazRouter.getAddress(),
        await env.evmRouter.getAddress(),
        await env.impl.getAddress(),
        await env.oracle.getAddress()] })).factory;
      const cfg = await fresh.config();
      expect(cfg.curveBps).to.eq(8500n);
      expect(cfg.liquidityTokenBps).to.eq(1300n);
      const base = { totalSupply: SUPPLY, graduationTarget: E(50_000) };
      await fresh.setConfig({ ...base, curveBps: 8500, liquidityTokenBps: 1300 });
      // r = pool / (0.98 * curve) must stay < 1
      // r >= 1 (pool cannot fit) needs curve <= ~50.5%; the 70% first-buy rule (audit F5) refuses it first.
      await expect(fresh.setConfig({ ...base, curveBps: 5000, liquidityTokenBps: 5000 })).to.be.revertedWithCustomError(fresh, "InvalidCurveBps");
      await expect(fresh.setConfig({ ...base, curveBps: 9999, liquidityTokenBps: 0 })).to.be.revertedWithCustomError(fresh, "SupplyBoundBroken");
      await expect(fresh.setConfig({ ...base, curveBps: 8500, liquidityTokenBps: 1600 })).to.be.revertedWithCustomError(fresh, "InvalidCurveBps");

      const min = BigInt(await env.factory.MIN_MARKET_CAP_NATIVE());
      expect(await env.oracle.nativeTargetForUsd(E(30_000)) < min).to.eq(true);
      expect(await env.oracle.nativeTargetForUsd(E(50_000)) >= min).to.eq(true);
      await expect(createCoin(env, req({ graduationTarget: E(30_000) }))).to.be.revertedWithCustomError(env.factory, "TargetOutOfRangeAtPrice");
      await createCoin(env, req({ graduationTarget: E(50_000) }));
    });

    it("REPLACED fuzz: every curve the factory sizes graduates within its 13% pool and burns only the ~0.01% margin", async () => {
      const env = await deployEvmGen7();
      for (const mc of [E("0.001"), E("0.5"), E(50), E(83), E(1234), E(1_000_000), E(500_000_000), 10n ** 30n]) {
        const [vN, vT] = await env.factory.curveForMarketCap(mc, SUPPLY, 8500, 1300);
        const ref = curveForMarketCap(mc);
        expect(vN).to.eq(ref.vNative);
        expect(vT).to.eq(ref.vToken);
        const R = curveNative(CURVE, vN, vT) - curveNative(0n, vN, vT);
        const pool = R - (R * 200n) / 10000n;
        const P = priceAt(CURVE, vN, vT);
        const T = (pool * W) / P;
        expect(T <= POOL, `mc=${mc}`).to.eq(true);
        expect(POOL - T <= POOL / 5000n, `mc=${mc} burn=${POOL - T}`).to.eq(true); // <= 0.02% of the pool
        // graduation market cap within the margin of the target
        expect(Number((((P * SUPPLY) / W) * 1_000_000n) / mc) / 1e4).to.be.closeTo(100, 0.02);
      }
      void area;
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
