/**
 * Audit 5: route-authority signatures (create + trade) and deployment ordering / initialization.
 *
 *   npx hardhat test test/audit5-signatures-deploy.spec.ts
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployEvmGen, createCoin, req, E, signCreate, signTrade, mineAt, now, area, hashReq, coder } from "./fixtures/evmgenCore";

const SECP_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

function highS(sig: string) {
  const s = ethers.Signature.from(sig);
  const sHigh = SECP_N - BigInt(s.s);
  const v = s.v === 27 ? 28 : 27;
  return ethers.concat([s.r, ethers.toBeHex(sHigh, 32), ethers.toBeHex(v, 1)]);
}

describe("audit5: create authorization (11-field hash)", function () {
  it("HOLDS: replay of the same create signature reverts RouteAuthorizationReplayed", async () => {
    const env = await deployEvmGen();
    const r = req();
    const auth = await signCreate(env.authority, await env.factory.getAddress(), env.creator.address, r);
    await env.factory.connect(env.creator).createCampaignAuthorized(r, auth);
    await expect(env.factory.connect(env.creator).createCampaignAuthorized(r, auth)).to.be.revertedWithCustomError(env.factory, "RouteAuthorizationReplayed");
  });

  it("HOLDS: a signature for factory A, or for another creator, or with any changed field, is refused on B / by the other wallet", async () => {
    const a = await deployEvmGen();
    const b = await deployEvmGen();
    await b.factory.setRouteAuthority(await a.authority.getAddress()); // same key on both factories, as in production
    const r = req({ firstBuyTokens: E(1_000_000), firstBuyMaxCost: E(1) });
    const auth = await signCreate(a.authority, await a.factory.getAddress(), a.creator.address, r);
    await expect(b.factory.connect(a.creator).createCampaignAuthorized(r, auth, { value: E(1) })).to.be.revertedWithCustomError(b.factory, "InvalidRouteAuthorization");
    await expect(a.factory.connect(a.alice).createCampaignAuthorized(r, auth, { value: E(1) })).to.be.revertedWithCustomError(a.factory, "InvalidRouteAuthorization");
    for (const over of [{ feeChoice: 2 }, { firstBuyTokens: E(2_000_000) }, { firstBuyMaxCost: E(2) }, { graduationTarget: E(15_000) }]) {
      await expect(a.factory.connect(a.creator).createCampaignAuthorized({ ...r, ...over }, auth, { value: E(2) })).to.be.revertedWithCustomError(a.factory, "InvalidRouteAuthorization");
    }
    await expect(a.factory.connect(a.creator).createCampaignAuthorized(r, { ...auth, tradeRouteProfile: 2 }, { value: E(1) })).to.be.revertedWithCustomError(a.factory, "InvalidRouteAuthorization");
    await a.factory.connect(a.creator).createCampaignAuthorized(r, auth, { value: E(1) });
  });

  it("HOLDS: a high-s (malleated) create signature is rejected, and replay is keyed on the digest anyway", async () => {
    const env = await deployEvmGen();
    const r = req();
    const auth = await signCreate(env.authority, await env.factory.getAddress(), env.creator.address, r);
    await expect(env.factory.connect(env.creator).createCampaignAuthorized(r, { ...auth, signature: highS(auth.signature) })).to.be.reverted;
    await env.factory.connect(env.creator).createCampaignAuthorized(r, auth);
  });

  it("HOLDS (leaked-key bound): a validly signed create still cannot exceed the on-chain first-buy and fee-choice bounds", async () => {
    const env = await deployEvmGen();
    const f = env.factory;
    const campaignImpl = await ethers.getContractAt("LaunchCampaign", await f.campaignImplementation());
    const tooMany = req({ firstBuyTokens: E(100_000_001), firstBuyMaxCost: E(10) }); // > 10% of 1B (~5.5 BNB)
    let auth = await signCreate(env.authority, await f.getAddress(), env.creator.address, tooMany);
    await expect(f.connect(env.creator).createCampaignAuthorized(tooMany, auth, { value: E(10) })).to.be.revertedWithCustomError(campaignImpl, "FirstBuyTooLarge");
    // BNB at $60,000: a $15k target is 0.25 BNB; 5% of supply (~1.4 BNB) is far above 50% of it
    const pricey = await deployEvmGen({ nativeUsd: 60_000 });
    const expensive = req({ graduationTarget: E(15_000), firstBuyTokens: E(50_000_000), firstBuyMaxCost: E(2) });
    auth = await signCreate(pricey.authority, await pricey.factory.getAddress(), pricey.creator.address, expensive);
    await expect(pricey.factory.connect(pricey.creator).createCampaignAuthorized(expensive, auth, { value: E(2) })).to.be.revertedWithCustomError(campaignImpl, "FirstBuyTooExpensive");
    for (const bad of [req({ feeChoice: 5 }), req({ feeChoice: 3, feeCreatorPct: 0 }), req({ feeChoice: 3, feeCreatorPct: 100 }), req({ feeChoice: 1, feeCreatorPct: 5 }), req({ feeChoice: 0 })]) {
      auth = await signCreate(env.authority, await f.getAddress(), env.creator.address, bad);
      await expect(f.connect(env.creator).createCampaignAuthorized(bad, auth)).to.be.revertedWithCustomError(f, "InvalidFeeChoice");
    }
  });

  it("INFO (leaked key): no maximum deadline -- a create signed to expire in 10 years is accepted", async () => {
    const env = await deployEvmGen();
    const r = req();
    const auth = await signCreate(env.authority, await env.factory.getAddress(), env.creator.address, r, [2, 2], (await now()) + 10 * 365 * 86400);
    await env.factory.connect(env.creator).createCampaignAuthorized(r, auth);
    const c = await ethers.getContractAt("LaunchCampaign", (await env.factory.getCampaign(0)).campaign);
    expect(await c.tradeRouteProfile()).to.eq(2); // the signer alone picks the OG-linked recruiter profile
  });
});

describe("audit5: trade authorization", function () {
  it("HOLDS: bound to chain, campaign, actor, action, amount, limit, deadline; replay refused", async () => {
    const env = await deployEvmGen();
    const { campaign: c1 } = await createCoin(env);
    const { campaign: c2 } = await createCoin(env, req({ symbol: "TWO" }), { from: env.bob });
    await mineAt(Number(await c2.launchAt()) + 61);
    const amount = E(1_000_000);
    const cost = await c1.quoteBuyExactTokens(amount);
    const a = await signTrade(env.authority, await c1.getAddress(), env.alice.address, 0, amount, cost);
    // other campaign
    await expect(c2.connect(env.alice).buyExactTokensAuthorized(amount, cost, a.profile, a.deadline, a.signature, { value: cost })).to.be.revertedWithCustomError(c2, "BadRouteAuth");
    // other actor
    await expect(c1.connect(env.bob).buyExactTokensAuthorized(amount, cost, a.profile, a.deadline, a.signature, { value: cost })).to.be.revertedWithCustomError(c1, "BadRouteAuth");
    // other profile / limit
    await expect(c1.connect(env.alice).buyExactTokensAuthorized(amount, cost, 0, a.deadline, a.signature, { value: cost })).to.be.revertedWithCustomError(c1, "BadRouteAuth");
    await expect(c1.connect(env.alice).buyExactTokensAuthorized(amount, cost + 1n, a.profile, a.deadline, a.signature, { value: cost + 1n })).to.be.revertedWithCustomError(c1, "BadRouteAuth");
    // malleated
    await expect(c1.connect(env.alice).buyExactTokensAuthorized(amount, cost, a.profile, a.deadline, highS(a.signature), { value: cost })).to.be.reverted;
    await c1.connect(env.alice).buyExactTokensAuthorized(amount, cost, a.profile, a.deadline, a.signature, { value: cost });
    await expect(c1.connect(env.alice).buyExactTokensAuthorized(amount, cost * 2n, a.profile, a.deadline, a.signature, { value: cost * 2n })).to.be.revertedWithCustomError(c1, "BadRouteAuth");
    const again = await c1.quoteBuyExactTokens(amount);
    await expect(c1.connect(env.alice).buyExactTokensAuthorized(amount, cost, a.profile, a.deadline, a.signature, { value: again })).to.be.revertedWithCustomError(c1, "RouteAuthReplayed");
  });

  it("HOLDS: buyExactBnb binds msg.value; a different value is a different digest", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env);
    await mineAt(Number(await campaign.launchAt()) + 61);
    const a = await signTrade(env.authority, await campaign.getAddress(), env.alice.address, 1, E(1), 0n);
    await expect(campaign.connect(env.alice).buyExactBnbAuthorized(0, a.profile, a.deadline, a.signature, { value: E(2) })).to.be.revertedWithCustomError(campaign, "BadRouteAuth");
    await campaign.connect(env.alice).buyExactBnbAuthorized(0, a.profile, a.deadline, a.signature, { value: E(1) });
  });

  it("HOLDS: rotating the factory's route authority invalidates every outstanding trade signature at once (campaigns read it live)", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env);
    await mineAt(Number(await campaign.launchAt()) + 61);
    const a = await signTrade(env.authority, await campaign.getAddress(), env.alice.address, 1, E(1), 0n);
    await env.factory.setRouteAuthority(env.carol.address);
    await expect(campaign.connect(env.alice).buyExactBnbAuthorized(0, a.profile, a.deadline, a.signature, { value: E(1) })).to.be.revertedWithCustomError(campaign, "BadRouteAuth");
    await env.factory.setRouteAuthority(ethers.ZeroAddress);
    await expect(campaign.connect(env.alice).buyExactBnbAuthorized(0, a.profile, a.deadline, a.signature, { value: E(1) })).to.be.revertedWithCustomError(campaign, "RouteAuthUnavailable");
  });

  it("HOLDS (leaked key): a forged trade auth cannot dodge the anti-sniper fee or the creator escrow; both are enforced on msg.sender and time", async () => {
    const env = await deployEvmGen();
    const { campaign, token } = await createCoin(env);
    const t0 = Number(await campaign.launchAt());
    const amount = E(1_000_000);
    const cost = area(amount);
    const a = await signTrade(env.authority, await campaign.getAddress(), env.creator.address, 0, amount, cost * 2n);
    await mineAt(t0 + 1);
    expect(await campaign.currentTradeFeeBps()).to.be.gt(4000n);
    await campaign.connect(env.creator).buyExactTokensAuthorized(amount, cost * 2n, a.profile, a.deadline, a.signature, { value: cost * 2n });
    expect(await token.balanceOf(env.creator.address)).to.eq(0n);
    expect(await campaign.creatorEscrowTotal()).to.eq(amount);
  });
});

describe("audit5: deployment ordering and initialization", function () {
  it("HOLDS: the campaign implementation cannot be initialized, and a factory clone cannot be re-initialized", async () => {
    const env = await deployEvmGen();
    const impl = env.impl;
    const params = {
      name: "X", symbol: "X", logoURI: "x", totalSupply: E(1000), curveBps: 5000, liquidityTokenBps: 4000, basePrice: 1n, priceSlope: 1n,
      graduationTarget: E(1), graduationOracle: await env.oracle.getAddress(), protocolFeeBps: 200, graduationAdapter: env.alice.address,
      feeRecipient: env.alice.address, creator: env.alice.address, factory: env.alice.address, riskRegistry: ethers.ZeroAddress,
      tokenDeployer: await env.tokenDeployer.getAddress(), creatorBuyCapWei: 0, requireAuthorizedTrading: false, tradeRouteProfile: 1, finalizeRouteProfile: 1,
    };
    await expect(impl.connect(env.alice).initialize(params)).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
    await expect(impl.connect(env.alice).initializeScheduled(params, 0)).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
    const { campaign } = await createCoin(env);
    await expect(campaign.connect(env.alice).initializeScheduled(params, 0)).to.be.revertedWithCustomError(campaign, "AlreadyInitialized");
    expect(await campaign.factory()).to.eq(await env.factory.getAddress());
  });

  it("HOLDS: campaign-only entry points refuse everyone but the factory (first buy, quote binding, pauses, trading flag, notify)", async () => {
    const env = await deployEvmGen();
    const { campaign } = await createCoin(env);
    await expect(campaign.connect(env.alice).creatorFirstBuy(1, { value: 1 })).to.be.revertedWithCustomError(campaign, "OnlyFactory");
    await expect(campaign.connect(env.alice).configureStockGraduation(env.bob.address, env.bob.address)).to.be.revertedWithCustomError(campaign, "OnlyFactory");
    await expect(campaign.connect(env.alice).setPauseState(true, true, true, true)).to.be.revertedWithCustomError(campaign, "OnlyFactory");
    await expect(campaign.connect(env.alice).setRequireAuthorizedTrading(false)).to.be.revertedWithCustomError(campaign, "OnlyFactory");
    await expect(env.factory.connect(env.alice).notifyCampaignGraduated(env.alice.address, env.alice.address)).to.be.revertedWithCustomError(env.factory, "UnknownCampaign");
  });

  it("HOLDS: locker bound by predicted nonce -- if nonce+1 is consumed by anything else the factory refuses the locker, and the orphan has no usable admin", async () => {
    const [deployer, stranger] = await ethers.getSigners();
    const env = await deployEvmGen();
    const nonce = await ethers.provider.getTransactionCount(deployer.address, "pending");
    const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
    const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(predicted, { nonce });
    await locker.waitForDeployment();
    await (await deployer.sendTransaction({ to: deployer.address, value: 0, nonce: nonce + 1 })).wait(); // nonce+1 burned
    const F = await ethers.getContractFactory("LaunchFactory");
    await expect(
      F.deploy(await env.topazRouter.getAddress(), await env.evmRouter.getAddress(), await env.impl.getAddress(), await env.oracle.getAddress(), await locker.getAddress()),
    ).to.be.revertedWithCustomError(F, "LockerNotBoundToFactory");
    expect((await ethers.provider.getCode(predicted)).length).to.eq(2);
    await expect(locker.connect(stranger).configureRevenue(stranger.address, stranger.address)).to.be.revertedWithCustomError(locker, "OnlyAdmin");
    // A stranger's deployments come from its own nonces; it cannot occupy the deployer's CREATE address.
    const theirs = await (await ethers.getContractFactory("AcceptingReceiver")).connect(stranger).deploy();
    expect(await theirs.getAddress()).to.not.eq(predicted);
  });

  it("HOLDS: setCampaignFactoryOnce / setFactoryOnce cannot be front-run: admin-only on every adapter and on the creator vault", async () => {
    const [admin, attacker] = await ethers.getSigners();
    const env = await deployEvmGen();
    const lockerAddr = await env.locker.getAddress();
    const nativeA = await (await ethers.getContractFactory("BnbNativeGraduationAdapter")).deploy(await env.topazFactory.getAddress(), await env.wbnb.getAddress(), lockerAddr);
    const fakeFactory = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(lockerAddr);
    await expect(nativeA.connect(attacker).setCampaignFactoryOnce(await fakeFactory.getAddress())).to.be.revertedWithCustomError(nativeA, "OnlyAdmin");
    await nativeA.connect(admin).setCampaignFactoryOnce(await env.factory.getAddress());
    await expect(nativeA.connect(admin).setCampaignFactoryOnce(await fakeFactory.getAddress())).to.be.revertedWithCustomError(nativeA, "FactoryAlreadyLocked");
    const v3 = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManager")).deploy(await v3.getAddress(), await weth.getAddress());
    const rh = await (await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2")).deploy(await v3.getAddress(), await npm.getAddress(), await weth.getAddress());
    await expect(rh.connect(attacker).setCampaignFactoryOnce(await fakeFactory.getAddress())).to.be.revertedWithCustomError(rh, "OnlyAdmin");
    const vault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(admin.address, admin.address, await env.wbnb.getAddress(), 1, await env.topazFactory.getAddress(), 86400);
    await expect(vault.connect(attacker).setFactoryOnce(await fakeFactory.getAddress())).to.be.revertedWithCustomError(vault, "OnlyAdmin");
  });

  it("HOLDS: LaunchTokenDeployer is harmless to call; LaunchToken stays locked for holders and approved spenders until graduation", async () => {
    const env = await deployEvmGen();
    const addr = await env.tokenDeployer.connect(env.alice).deploy.staticCall("Fake", "F", 1);
    await env.tokenDeployer.connect(env.alice).deploy("Fake", "F", 1);
    const fake = await ethers.getContractAt("LaunchToken", addr);
    expect(await fake.owner()).to.eq(env.alice.address);
    const { campaign, token } = await createCoin(env);
    expect(await token.owner()).to.eq(await campaign.getAddress());
    await mineAt(Number(await campaign.launchAt()) + 61);
    const amount = E(1_000_000);
    const cost = await campaign.quoteBuyExactTokens(amount);
    const a = await signTrade(env.authority, await campaign.getAddress(), env.alice.address, 0, amount, cost);
    await campaign.connect(env.alice).buyExactTokensAuthorized(amount, cost, a.profile, a.deadline, a.signature, { value: cost });
    await token.connect(env.alice).approve(env.bob.address, amount);
    await expect(token.connect(env.bob).transferFrom(env.alice.address, env.bob.address, 1n)).to.be.revertedWithCustomError(token, "TradingNotEnabled");
    await expect(token.connect(env.alice).transfer(await env.topazFactory.getAddress(), 1n)).to.be.revertedWithCustomError(token, "TradingNotEnabled");
    await expect(token.connect(env.alice).enableTrading()).to.be.reverted;
    await expect(token.connect(env.alice).burn(env.alice.address, 1n)).to.be.reverted;
    expect(hashReq(req()).length).to.eq(66);
    expect(coder).to.not.eq(undefined);
  });
});
