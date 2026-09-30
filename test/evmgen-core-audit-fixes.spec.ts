import { expect } from "chai";
import { ethers } from "hardhat";
import { deployEvmGen, createCoin, req, E, mineAt, buyNative, signTrade, signCreate, now, DAY, setNextTimestamp } from "./fixtures/evmgenCore";

// Fixes for the internal audits (1, 2, 5) in the campaign and factory. Attack tests stay in
// audit1-trading.spec.ts / audit2-core-graduation.spec.ts as HOLDS.
describe("evmgen core: audit fixes", function () {
  it("audit 5: a trade authorization valid for more than a day is refused; exactly a day is accepted", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env, req());
    await mineAt(Number(await campaign.launchAt()) + 61);
    const addr = await campaign.getAddress();
    const t = (await now()) + 10;
    // The trade lands at exactly t: deadline t + DAY + 1 is one second too long.
    const long = await signTrade(env.authority, addr, env.alice.address, 1, E(1), 0n, 1, t + 1 + DAY);
    await setNextTimestamp(t);
    await expect(
      campaign.connect(env.alice).buyExactBnbAuthorized(0n, long.profile, long.deadline, long.signature, { value: E(1) }),
    ).to.be.revertedWithCustomError(campaign, "RouteAuthTooLong");
    const t2 = await now();
    const tenYears = await signTrade(env.authority, addr, env.alice.address, 1, E(1), 0n, 1, t2 + 3650 * DAY);
    await expect(
      campaign.connect(env.alice).buyExactBnbAuthorized(0n, tenYears.profile, tenYears.deadline, tenYears.signature, { value: E(1) }),
    ).to.be.revertedWithCustomError(campaign, "RouteAuthTooLong");
    const t3 = (await now()) + 10;
    const ok = await signTrade(env.authority, addr, env.alice.address, 1, E(1), 0n, 1, t3 + DAY);
    await setNextTimestamp(t3);
    await campaign.connect(env.alice).buyExactBnbAuthorized(0n, ok.profile, ok.deadline, ok.signature, { value: E(1) });
  });

  it("audit 5: a create authorization valid for more than a day is refused; exactly a day is accepted", async () => {
    const env = await deployEvmGen();
    const f = await env.factory.getAddress();
    const r = req();
    const t = (await now()) + 10;
    const long = await signCreate(env.authority, f, env.creator.address, r, undefined, t + 1 + DAY);
    await setNextTimestamp(t);
    await expect(env.factory.connect(env.creator).createCampaignAuthorized(r, long)).to.be.revertedWithCustomError(
      env.factory,
      "RouteAuthorizationTooLong",
    );
    const t2 = (await now()) + 10;
    const ok = await signCreate(env.authority, f, env.creator.address, r, undefined, t2 + DAY);
    await setNextTimestamp(t2);
    await env.factory.connect(env.creator).createCampaignAuthorized(r, ok);
    expect(await env.factory.campaignsCount()).to.eq(1n);
  });

  it("audit 1: the factory refuses plain native transfers (nothing can be trapped there)", async () => {
    const env = await deployEvmGen();
    await expect(env.alice.sendTransaction({ to: await env.factory.getAddress(), value: 1n })).to.be.reverted;
    expect(await ethers.provider.getBalance(await env.factory.getAddress())).to.eq(0n);
  });

  it("audit 1: ownership can still move to another wallet, and graduate() pays the reserve and the claim to the new owner", async () => {
    const env = await deployEvmGen();
    const { campaign, token } = await createCoin(env, req());
    await mineAt(Number(await campaign.launchAt()) + 61);
    await campaign.connect(env.creator).transferOwnership(env.carol.address);
    await buyNative(env, campaign, env.alice, E(60));
    await env.owner.sendTransaction({ to: await env.adapter.getAddress(), value: E(10) });
    await campaign.graduate();
    expect(await token.balanceOf(env.carol.address)).to.eq(await campaign.creatorReserve());
    expect(await campaign.creatorGraduationBeneficiary()).to.eq(env.carol.address);
  });

  it("audit 1/2: a pause only on buys still starts the shared window; after 72 h sells and graduation ignore every flag", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env, req());
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(env, campaign, env.alice, E(60)); // Pending
    const a = await campaign.getAddress();
    await env.factory.setCampaignPauses(a, false, true, false, false);
    const p0 = Number(await campaign.pausedAt());
    // Flags added later inside the 144 h re-arm period keep the first window.
    await mineAt(p0 + 50 * 3600);
    await env.factory.setCampaignPauses(a, true, true, true, true);
    expect(Number(await campaign.pausedAt())).to.eq(p0);
    await expect(campaign.graduate()).to.be.revertedWithCustomError(campaign, "GraduationPaused");
    await mineAt(p0 + 72 * 3600);
    await env.owner.sendTransaction({ to: await env.adapter.getAddress(), value: E(10) });
    await campaign.graduate();
    expect(await campaign.launched()).to.eq(true);
  });

  it("audit 1/2: after the 144 h re-arm period a new pause starts a new 72 h window", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env, req());
    await mineAt(Number(await campaign.launchAt()) + 61);
    await buyNative(env, campaign, env.alice, E(20));
    const a = await campaign.getAddress();
    await env.factory.setCampaignPauses(a, true, true, true, true);
    const p0 = Number(await campaign.pausedAt());
    await mineAt(p0 + 144 * 3600);
    await env.factory.setCampaignPauses(a, true, true, true, true);
    expect(Number(await campaign.pausedAt())).to.eq(p0 + 144 * 3600 + 1);
  });
});
