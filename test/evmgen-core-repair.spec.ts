/**
 * C5/C7: the campaign's permissionless chunked pool repair, `repairPool(uint160 limit)`, and how
 * graduate() consumes earlier steps. Unit level, against MockGraduationAdapterEvmGen.repairStep
 * (the real V3 path is covered by test/evmgen-rh-core-integration.fork.spec.ts).
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployEvmGen, createCoin, req, E, mineAt, buyNative, now, hashReq, coder, type Env } from "./fixtures/evmgenCore";
import { deployFactoryWithLocker } from "../scripts/lib/deployFactoryWithLocker";

const W = 10n ** 18n;
const MAX = ethers.MaxUint256;

async function pendingCoin(env?: Env) {
  env = env ?? (await deployEvmGen());
  const { campaign, token } = await createCoin(env, req());
  await mineAt(Number(await campaign.launchAt()) + 61);
  await buyNative(env, campaign, env.alice, E(60));
  expect(await campaign.graduationPending()).to.eq(true);
  // native the mock pays out as repair proceeds
  await env.owner.sendTransaction({ to: await env.adapter.getAddress(), value: E(10) });
  return { env, campaign, token };
}

async function plan(campaign: any) {
  const g = await campaign.getGraduationState();
  const R: bigint = g.graduationBalance;
  const P: bigint = g.finalCurvePrice;
  const pool = R - (R * 220n) / 10000n - (R * 1980n) / 10000n;
  const T = (pool * W) / P;
  const B = (await campaign.totalSupply()) - (await campaign.creatorReserve()) - (await campaign.sold());
  return { R, P, pool, T, B };
}

describe("evmgen core C5/C7: repairPool (chunked pre-made pool repair)", function () {
  describe("refusals", function () {
    it("Trading and not due: GraduationNotDue; nothing is approved or called", async () => {
      const env = await deployEvmGen();
      const { campaign } = await createCoin(env, req());
      await mineAt(Number(await campaign.launchAt()) + 61);
      await expect(campaign.repairPool(0)).to.be.revertedWithCustomError(campaign, "GraduationNotDue");
      expect(await env.adapter.stepCalls()).to.eq(0n);
    });

    it("scheduled coin before launchAt: TradingNotOpen", async () => {
      const env = await deployEvmGen();
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
        coder.encode(
          ["string", "uint256", "address", "address", "bytes32", "uint64", "bytes32", "bytes32", "bytes32", "uint64", "uint256", "uint32", "uint32", "uint8", "uint8", "uint64"],
          ["MWZ_CREATE_SCHEDULED_V2_AUTH", chainId, await env.factory.getAddress(), env.creator.address, hashReq(r), launchAt, sreq.draftReferenceHash, sreq.normalizedTickerHash, sreq.metadataHash, 1, 7, 6, 5, 1, 1, dl],
        ),
      );
      const sig = await env.authority.signMessage(ethers.getBytes(payload));
      await env.factory.connect(env.creator).createScheduledCampaignAuthorized(sreq, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature: sig });
      const campaign = await ethers.getContractAt("LaunchCampaign", (await env.factory.getCampaign(0)).campaign);
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
    it("due but not Pending (oracle failed on the crossing buy): repairPool marks Pending and steps", async () => {
      const env = await deployEvmGen();
      const { campaign } = await createCoin(env, req());
      await mineAt(Number(await campaign.launchAt()) + 61);
      const t = await now();
      await env.feed.setRoundData(2, 0, t, t, 2);
      await buyNative(env, campaign, env.alice, E(60));
      expect(await campaign.graduationPending()).to.eq(false);
      const t2 = await now();
      await env.feed.setRoundData(3, 600n * 10n ** 8n, t2, t2, 3);
      await expect(campaign.connect(env.carol).repairPool(0)).to.emit(campaign, "GraduationPending").and.to.emit(campaign, "PoolRepairStep");
      expect(await campaign.graduationPending()).to.eq(true);
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

  describe("quote coin (base LaunchCampaign quote path, via the BNB quote implementation)", function () {
    async function quoteCoin() {
      const env = await deployEvmGen();
      const quoteImpl = await (await ethers.getContractFactory("BnbQuoteLaunchCampaign")).deploy();
      const factory = (
        await deployFactoryWithLocker({
          factoryName: "BnbBasicLaunchFactory",
          args: [await env.topazRouter.getAddress(), await env.evmRouter.getAddress(), await env.impl.getAddress(), await env.oracle.getAddress(), await quoteImpl.getAddress()],
        })
      ).factory;
      await env.vault.setFactory(await factory.getAddress());
      const qa = await (await ethers.getContractFactory("MockGraduationAdapterEvmGen")).deploy(await env.topazFactory.getAddress(), await env.wbnb.getAddress());
      await qa.setLocker(await factory.permanentLpLocker());
      const quote = await (await ethers.getContractFactory("MockERC20")).deploy("USDT", "USDT", E(10n ** 12n), await qa.getAddress());
      await factory.setNativeGraduationAdapter(await env.adapter.getAddress());
      await factory.setLaunchTokenDeployer(await env.tokenDeployer.getAddress());
      await factory.setBnbQuoteGraduationAdapter(await qa.getAddress());
      await factory.setRouteAuthority(env.authority.address);
      await factory.enableLive();
      const r = req();
      const binding = ethers.id("catalog-binding");
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const dl = (await now()) + 3600;
      const payload = ethers.keccak256(
        coder.encode(
          ["string", "uint256", "address", "address", "bytes32", "address", "bytes32", "address", "address", "uint32", "uint32", "uint8", "uint8", "uint64"],
          ["MWZ_CREATE_BNB_BASIC_QUOTE_AUTH_V2", chainId, await factory.getAddress(), env.creator.address, hashReq(r), await quote.getAddress(), binding, await qa.getAddress(), await quoteImpl.getAddress(), 6, 5, 1, 1, dl],
        ),
      );
      const signature = await env.authority.signMessage(ethers.getBytes(payload));
      await factory.connect(env.creator).createBasicQuoteCampaignAuthorized(r, await quote.getAddress(), binding, { tradeRouteProfile: 1, finalizeRouteProfile: 1, deadline: dl, signature });
      const info = await factory.getCampaign((await factory.campaignsCount()) - 1n);
      const campaign = await ethers.getContractAt("BnbQuoteLaunchCampaign", info.campaign);
      await mineAt(Number(await campaign.launchAt()) + 61);
      await buyNative(env as any, campaign, env.alice, E(60));
      expect(await campaign.graduationPending()).to.eq(true);
      await env.owner.sendTransaction({ to: await qa.getAddress(), value: E(1) });
      return { env, campaign, qa, quote };
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
