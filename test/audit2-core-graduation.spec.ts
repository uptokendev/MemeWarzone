/**
 * Audit 2 (independent): LaunchCampaign graduation properties on the core mocks.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployEvmGen, createCoin, req, E, mineAt, buyNative, now } from "./fixtures/evmgenCore";

const W = 10n ** 18n;

async function pendingCoin() {
  const env = await deployEvmGen();
  const { campaign, token } = await createCoin(env, req());
  await mineAt(Number(await campaign.launchAt()) + 61);
  await buyNative(env, campaign, env.alice, E(60));
  expect(await campaign.graduationPending()).to.eq(true);
  await env.owner.sendTransaction({ to: await env.adapter.getAddress(), value: E(10) });
  return { env, campaign, token };
}

describe("audit2: LaunchCampaign graduation", function () {
  it("HOLDS: split conservation R == 2.2% + 19.8% + 78% (+dust) and MEME budget conservation across repair steps", async () => {
    const { env, campaign, token } = await pendingCoin();
    const g0 = await campaign.getGraduationState();
    const R: bigint = g0.graduationBalance;
    const P: bigint = g0.finalCurvePrice;
    const pool = R - (R * 220n) / 10000n - (R * 1980n) / 10000n;
    const T = (pool * W) / P;
    const B = (await campaign.totalSupply()) - (await campaign.creatorReserve()) - (await campaign.sold());
    await env.adapter.setStep((B - T) / 4n, E("0.3"), 0, 0, 0);
    await campaign.connect(env.carol).repairPool(0);
    await env.adapter.setStep((B - T) / 5n, E("0.2"), 0, 0, 0);
    await campaign.connect(env.carol).repairPool(0);
    const sold = await campaign.repairMemeSold();
    const supply0 = await token.totalSupply();
    await env.adapter.setBehaviour(false, false, 0, 0, 0, 0, false);
    const routerBal0 = await ethers.provider.getBalance(await env.evmRouter.getAddress());
    await campaign.connect(env.carol).graduate();
    const g = await campaign.getGraduationState();
    expect((R * 220n) / 10000n + (R * 1980n) / 10000n + pool).to.eq(R);
    expect(await campaign.pendingCreatorGraduation()).to.be.gte((R * 1980n) / 10000n);
    expect((await ethers.provider.getBalance(await env.evmRouter.getAddress())) - routerBal0 + (await campaign.pendingProtocolGraduationFee())).to.eq((R * 220n) / 10000n);
    expect(g.graduatedLiquidityBnb).to.eq(pool + E("0.5"));
    expect(g.graduatedLiquidityTokens + g.burnedUnsoldTokens).to.eq(B);
    expect(sold).to.be.lte(B - T);
    expect(supply0 - (await token.totalSupply())).to.eq(g.burnedUnsoldTokens);
    expect(await campaign.excessNativeBalance()).to.eq(0n);
  });

  it("HOLDS: useNativeFallback is refused for a native coin (no quote), and before/after graduation", async () => {
    const { campaign } = await pendingCoin();
    await expect(campaign.useNativeFallback()).to.be.revertedWithCustomError(campaign, "NativeFallbackUnavailable");
    await campaign.graduate();
    await expect(campaign.useNativeFallback()).to.be.revertedWithCustomError(campaign, "Finalized");
  });

  it("HOLDS: claimCreatorGraduation only by the beneficiary; `to` is the beneficiary's choice; double claim refused", async () => {
    const { env, campaign } = await pendingCoin();
    await campaign.graduate();
    await expect(campaign.connect(env.alice).claimCreatorGraduation(env.alice.address, true)).to.be.revertedWithCustomError(campaign, "NotBeneficiary");
    const owed = await campaign.pendingCreatorGraduation();
    const b0 = await ethers.provider.getBalance(env.bob.address);
    await campaign.connect(env.creator).claimCreatorGraduation(env.bob.address, true);
    expect((await ethers.provider.getBalance(env.bob.address)) - b0).to.eq(owed);
    await expect(campaign.connect(env.creator).claimCreatorGraduation(env.bob.address, true)).to.be.revertedWithCustomError(campaign, "NothingToClaim");
  });

  it("HOLDS: flushProtocolGraduationFee with nothing escrowed reverts; nothing to steal", async () => {
    const { campaign } = await pendingCoin();
    await campaign.graduate();
    await expect(campaign.flushProtocolGraduationFee()).to.be.revertedWithCustomError(campaign, "NothingToClaim");
  });

  it("HOLDS: the graduation pause is honoured only for 72 h after pendingSince", async () => {
    const { env, campaign } = await pendingCoin();
    const since = Number(await campaign.pendingSince());
    await env.factory.setCampaignPauses(await campaign.getAddress(), true, true, true, true);
    await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "GraduationPaused");
    await mineAt(since + 72 * 3600);
    await env.adapter.setBehaviour(false, false, 0, 0, 0, 0, false);
    await campaign.graduate();
    expect(await campaign.launched()).to.eq(true);
  });

  it("HOLDS: a campaign paused while Trading that becomes due through the oracle enters Pending anyway, so the 72 h cap starts (was EXPLOIT, fixed)", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env, req());
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(env, campaign, env.alice, E(20)); // not due at $600
    expect(await campaign.graduationPending()).to.eq(false);
    await env.factory.setCampaignPauses(await campaign.getAddress(), true, true, true, true);
    const t = await now();
    await env.feed.setRoundData(5, 100_000n * 10n ** 8n, t, t, 5); // native up: now due
    // graduate() records Pending and returns (no revert, so the entry is kept); the pool is not built.
    await expect(campaign.graduate()).to.emit(campaign, "GraduationPending");
    expect(await campaign.graduationPending()).to.eq(true);
    expect(await campaign.launched()).to.eq(false);
    const since = Number(await campaign.pendingSince());
    // While the pause is honoured a second call reverts as before.
    await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "GraduationPaused");
    await mineAt(since + 72 * 3600);
    await env.owner.sendTransaction({ to: await env.adapter.getAddress(), value: E(10) });
    await campaign.graduate();
    expect(await campaign.launched()).to.eq(true);
  });
});
