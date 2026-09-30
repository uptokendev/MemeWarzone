import { expect } from "chai";
import { ethers, network } from "hardhat";

// C6 / D19 / E10: CreatorRewardsVaultV2. Spec docs/evm-launch/spec/C1-C6-fees.md.
const E18 = 10n ** 18n;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const KEEP = 1, HOLDERS = 2, SPLIT = 3, BUYBACK = 4;
const DAY = 86400;

async function increase(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

async function base() {
  const [admin, operator, creator, trader, other] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const monthly = await Receiver.deploy();
  const recruiter = await Receiver.deploy();
  const protocol = await Receiver.deploy();
  const community = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(admin.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
  const vault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(
    admin.address, await router.getAddress(), await weth.getAddress(), 1, await topazFactory.getAddress(), DAY,
  );
  await router.setRecruiterRewardsVault(await recruiter.getAddress());
  await router.setCommunityRewardsVault(await community.getAddress());
  await router.setProtocolRevenueVault(await protocol.getAddress());
  await router.setCreatorRewardsVault(await vault.getAddress());

  const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(admin.address);
  await locker.configureRevenue(await router.getAddress(), await topazFactory.getAddress());
  await router.setAuthorizedLpLocker(await locker.getAddress(), true);
  const factory = await (await ethers.getContractFactory("MockFactoryEvmGen")).deploy(await locker.getAddress());
  await vault.setFactoryOnce(await factory.getAddress());
  const distributor = await (await ethers.getContractFactory("RewardDistributor")).deploy(admin.address);
  await distributor.setBatchOperator(await vault.getAddress());
  await vault.setHolderDistributorOnce(await distributor.getAddress());
  await vault.setOperator(operator.address, false);
  await vault.setCaps(E18, 3n * E18, 3600, 50, 10n * E18);

  async function campaignWith(choice: number, pct = 0, target = 100n * E18) {
    const campaign = await (await ethers.getContractFactory("MockCampaignEvmGen")).deploy(await router.getAddress(), target);
    await factory.addCampaign(await campaign.getAddress());
    await factory.choose(await vault.getAddress(), await campaign.getAddress(), creator.address, choice, pct);
    const token = await ethers.getContractAt("MockLaunchTokenEvmGen", await campaign.token());
    return { campaign, token };
  }
  // A trade fee of `fee` routed by the campaign: creator part = floor(fee*560/1e4).
  async function tradeFee(campaign: any, fee: bigint) {
    await campaign.connect(trader).payFee(1, { value: fee });
    return (fee * 560n) / 10000n;
  }
  async function invariant() {
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.be.gte(await vault.totalLiabilities());
  }
  // Graduates `campaign` into a Topaz pair against `paired`, registered the way the new factory must.
  async function graduate(campaign: any, token: any, paired: any, nonKeep: boolean, recipientOverride?: string) {
    await campaign.graduate();
    await campaign.mintTo(admin.address, 2_000_000n * E18);
    const pair = await (await ethers.getContractFactory("MockTopazPairEvmGen")).deploy();
    await topazFactory.setPool(await token.getAddress(), await paired.getAddress(), false, await pair.getAddress());
    await token.approve(await pair.getAddress(), ethers.MaxUint256);
    await paired.approve(await pair.getAddress(), ethers.MaxUint256);
    const memeIs0 = (await pair.token0()).toLowerCase() === (await token.getAddress()).toLowerCase();
    const rm = 1_000_000n * E18;
    const rp = 100n * E18;
    await pair.seed(memeIs0 ? rm : rp, memeIs0 ? rp : rm);
    await pair.setTwapFollowsSpot(true); // pool with TWAP history at spot (fix F3/F4: the TWAP guard fails closed)
    await pair.mint(await locker.getAddress(), E18);
    const c = await campaign.getAddress();
    await locker.registerGraduatedPool(
      c,
      nonKeep ? c : creator.address,
      recipientOverride ?? (nonKeep ? await vault.getAddress() : creator.address),
      await pair.getAddress(),
      await token.getAddress(),
      await paired.getAddress(),
      E18,
    );
    async function fundFees(memeFee: bigint, pairedFee: bigint) {
      await pair.fundFees(await locker.getAddress(), memeIs0 ? memeFee : pairedFee, memeIs0 ? pairedFee : memeFee);
    }
    return { pair, memeIs0, fundFees };
  }
  async function wrapped(amount: bigint) {
    await weth.deposit({ value: amount });
    return weth;
  }
  return { admin, operator, creator, trader, other, weth, topazFactory, router, vault, locker, factory, distributor, campaignWith, tradeFee, invariant, graduate, wrapped };
}

describe("evmgen fees: CreatorRewardsVaultV2 choice and accrual", function () {
  it("limits() reports the operator limits exactly as setCaps and setOperator wrote them", async function () {
    const f = await base();
    let l = await f.vault.limits();
    expect([l[0], l[1], l[2], l[3], l[4], l[5]]).to.deep.equal([false, E18, 3n * E18, 3600n, 50n, 10n * E18]);
    await f.vault.setCaps(2n * E18, 5n * E18, 21600, 40, 20n * E18);
    await f.vault.setOperator(await f.vault.operator(), true);
    l = await f.vault.limits();
    expect([l[0], l[1], l[2], l[3], l[4], l[5]]).to.deep.equal([true, 2n * E18, 5n * E18, 21600n, 40n, 20n * E18]);
  });

  it("the choice is set once, by the factory only, with pct only for split", async function () {
    const f = await base();
    const { campaign } = await f.campaignWith(KEEP);
    const c = await campaign.getAddress();
    await expect(f.vault.setCampaignChoice(c, f.creator.address, KEEP, 0)).to.be.revertedWithCustomError(f.vault, "OnlyFactory");
    await expect(f.factory.choose(await f.vault.getAddress(), c, f.creator.address, HOLDERS, 0)).to.be.revertedWithCustomError(f.vault, "AlreadySet");
    const x = f.other.address;
    for (const [ch, pct] of [[0, 0], [5, 0], [SPLIT, 0], [SPLIT, 100], [KEEP, 5], [HOLDERS, 1], [BUYBACK, 50]]) {
      await expect(f.factory.choose(await f.vault.getAddress(), x, f.creator.address, ch, pct)).to.be.revertedWithCustomError(f.vault, "BadChoice");
    }
    await f.factory.choose(await f.vault.getAddress(), x, f.creator.address, SPLIT, 99);
    expect((await f.vault.cfg(x)).creatorPct).to.equal(99n);
    expect(await f.vault.isKeep(c)).to.equal(true);
    expect(await f.vault.isKeep(x)).to.equal(false);
  });

  it("accrueTradeFee is router-only, refuses an unset campaign, and splits for every choice", async function () {
    const f = await base();
    await expect(f.vault.accrueTradeFee(f.other.address, { value: 1n })).to.be.revertedWithCustomError(f.vault, "OnlyRouter");
    const fee = 1_234_567_891n;
    const v = (fee * 560n) / 10000n;
    const keep = await f.campaignWith(KEEP);
    const holders = await f.campaignWith(HOLDERS);
    const split = await f.campaignWith(SPLIT, 33);
    const buyback = await f.campaignWith(BUYBACK);
    for (const x of [keep, holders, split, buyback]) await f.tradeFee(x.campaign, fee);
    expect(await f.vault.creatorBalance(await keep.campaign.getAddress())).to.equal(v);
    expect(await f.vault.holderBalance(await holders.campaign.getAddress())).to.equal(v);
    const k = (v * 33n) / 100n;
    expect(await f.vault.creatorBalance(await split.campaign.getAddress())).to.equal(k);
    expect(await f.vault.holderBalance(await split.campaign.getAddress())).to.equal(v - k);
    expect(await f.vault.buybackBalance(await buyback.campaign.getAddress())).to.equal(v);
    expect(await f.vault.totalLiabilities()).to.equal(v * 4n);
    await f.invariant();
  });
});

describe("evmgen fees: CreatorRewardsVaultV2 creator claim", function () {
  it("pays keep and the split creator part to the creator only; a rejecting or re-entering creator cannot break it", async function () {
    const f = await base();
    const { campaign } = await f.campaignWith(SPLIT, 40);
    const v = await f.tradeFee(campaign, 10n ** 15n);
    const c = await campaign.getAddress();
    await expect(f.vault.connect(f.other).claimCreatorFees(c)).to.be.revertedWithCustomError(f.vault, "NotCreator");
    const before = await ethers.provider.getBalance(f.creator.address);
    const tx = await f.vault.connect(f.creator).claimCreatorFees(c);
    const rc = await tx.wait();
    const gas = rc!.gasUsed * rc!.gasPrice;
    expect((await ethers.provider.getBalance(f.creator.address)) - before + gas).to.equal((v * 40n) / 100n);
    await expect(f.vault.connect(f.creator).claimCreatorFees(c)).to.be.revertedWithCustomError(f.vault, "NothingToClaim");
    expect(await f.vault.holderBalance(c)).to.equal(v - (v * 40n) / 100n);

    const actor = await (await ethers.getContractFactory("MockCreatorActorEvmGen")).deploy();
    const campaign2 = await (await ethers.getContractFactory("MockCampaignEvmGen")).deploy(await f.router.getAddress(), E18);
    await f.factory.addCampaign(await campaign2.getAddress());
    await f.factory.choose(await f.vault.getAddress(), await campaign2.getAddress(), await actor.getAddress(), KEEP, 0);
    const v2 = await f.tradeFee(campaign2, 10n ** 15n);
    await actor.setMode(1, await f.vault.getAddress(), await campaign2.getAddress());
    await expect(actor.claim(await f.vault.getAddress(), await campaign2.getAddress())).to.be.revertedWithCustomError(f.vault, "TransferFailed");
    await actor.setMode(2, await f.vault.getAddress(), await campaign2.getAddress());
    await expect(actor.claim(await f.vault.getAddress(), await campaign2.getAddress())).to.be.revertedWithCustomError(f.vault, "TransferFailed");
    expect(await f.vault.creatorBalance(await campaign2.getAddress())).to.equal(v2);
    await actor.setMode(0, await f.vault.getAddress(), await campaign2.getAddress());
    await actor.claim(await f.vault.getAddress(), await campaign2.getAddress());
    expect(await ethers.provider.getBalance(await actor.getAddress())).to.equal(v2);
    await f.invariant();
  });
});

describe("evmgen fees: CreatorRewardsVaultV2 LP fees follow the choice (D19, E9)", function () {
  it("a holders coin: harvest pays WBNB to the vault, sync unwraps and credits 80% exactly, once; the creator cannot redirect it", async function () {
    const f = await base();
    const { campaign, token } = await f.campaignWith(HOLDERS);
    await f.wrapped(300n * E18);
    const g = await f.graduate(campaign, token, f.weth, true);
    await g.fundFees(1_000n * E18, 2n * E18);
    const out = await g.pair.getAmountOut(1_000n * E18, await token.getAddress());
    await f.locker.harvest(await g.pair.getAddress());
    const expected = ((2n * E18 + out) * 8000n) / 10000n;
    expect(await f.weth.balanceOf(await f.vault.getAddress())).to.equal(expected);
    expect(await token.balanceOf(await f.vault.getAddress())).to.equal(0n);
    const c = await campaign.getAddress();
    await expect(f.vault.syncLpFees(await g.pair.getAddress())).to.emit(f.vault, "LpFeesSynced").withArgs(c, await g.pair.getAddress(), await f.weth.getAddress(), expected);
    expect(await f.vault.holderBalance(c)).to.equal(expected);
    expect(await f.weth.balanceOf(await f.vault.getAddress())).to.equal(0n);
    expect(await f.vault.syncLpFees.staticCall(await g.pair.getAddress())).to.equal(0n);
    await f.invariant();
    // The real creator is not the locker key for this pool.
    await expect(f.locker.connect(f.creator).updateCreatorPayoutRecipient(f.creator.address)).to.be.revertedWithCustomError(f.locker, "OnlyCreator");
    // A keep coin by the same creator is paid directly and cannot be synced.
    const keep = await f.campaignWith(KEEP);
    const gk = await f.graduate(keep.campaign, keep.token, f.weth, false);
    await gk.fundFees(0n, E18);
    await f.locker.harvest(await gk.pair.getAddress());
    expect(await f.weth.balanceOf(f.creator.address)).to.equal((E18 * 8000n) / 10000n);
    await expect(f.vault.syncLpFees(await gk.pair.getAddress())).to.be.revertedWithCustomError(f.vault, "PoolMismatch");
  });

  it("refuses a pool whose recipient is not the vault, and a keep choice registered the non-keep way", async function () {
    const f = await base();
    const h = await f.campaignWith(HOLDERS);
    await f.wrapped(300n * E18);
    const g = await f.graduate(h.campaign, h.token, f.weth, true, f.other.address);
    await expect(f.vault.syncLpFees(await g.pair.getAddress())).to.be.revertedWithCustomError(f.vault, "PoolMismatch");
    const k = await f.campaignWith(KEEP);
    const gk = await f.graduate(k.campaign, k.token, f.weth, true);
    await expect(f.vault.syncLpFees(await gk.pair.getAddress())).to.be.revertedWithCustomError(f.vault, "WrongChoice");
  });

  it("E10 split coin on a quote pool: creator part claimable in quote, holders part converted to native through the route", async function () {
    const f = await base();
    const quote = await (await ethers.getContractFactory("MockERC20")).deploy("Quote", "USDX", 10n ** 30n, f.admin.address);
    const { campaign, token } = await f.campaignWith(SPLIT, 25);
    const g = await f.graduate(campaign, token, quote, true);
    await g.fundFees(500n * E18, 10n * E18);
    const out = await g.pair.getAmountOut(500n * E18, await token.getAddress());
    await f.locker.harvest(await g.pair.getAddress());
    const lp = ((10n * E18 + out) * 8000n) / 10000n;
    await f.vault.syncLpFees(await g.pair.getAddress());
    const c = await campaign.getAddress();
    expect(await f.vault.creatorQuoteBalance(c)).to.equal((lp * 25n) / 100n);
    expect(await f.vault.holderQuoteBalance(c)).to.equal(lp - (lp * 25n) / 100n);
    expect(await f.vault.quoteLiabilities(await quote.getAddress())).to.equal(lp);
    await f.vault.connect(f.creator).claimCreatorQuote(c);
    expect(await quote.balanceOf(f.creator.address)).to.equal((lp * 25n) / 100n);

    // Route pool quote/WBNB, then the holders' quote becomes native.
    await expect(f.vault.connect(f.operator).convertHolderQuote(c, E18)).to.be.revertedWithCustomError(f.vault, "NoRoute");
    const route = await (await ethers.getContractFactory("MockTopazPairEvmGen")).deploy();
    await f.topazFactory.setPool(await quote.getAddress(), await f.weth.getAddress(), false, await route.getAddress());
    await f.wrapped(1_000n * E18);
    await quote.approve(await route.getAddress(), ethers.MaxUint256);
    await f.weth.approve(await route.getAddress(), ethers.MaxUint256);
    const qIs0 = (await route.token0()).toLowerCase() === (await quote.getAddress()).toLowerCase();
    await route.seed(qIs0 ? 1_000_000n * E18 : 500n * E18, qIs0 ? 500n * E18 : 1_000_000n * E18);
    await route.setTwapFollowsSpot(true); // pool with TWAP history at spot (fix F3/F4: the TWAP guard fails closed)
    await expect(f.vault.connect(f.other).setQuoteRoute(await quote.getAddress(), 0)).to.be.revertedWithCustomError(f.vault, "OnlyAdmin");
    await f.vault.setQuoteRoute(await quote.getAddress(), 0);
    const holderQuote = await f.vault.holderQuoteBalance(c);
    const nativeOut = await route.getAmountOut(holderQuote, await quote.getAddress());
    await f.vault.connect(f.operator).convertHolderQuote(c, holderQuote);
    expect(await f.vault.holderQuoteBalance(c)).to.equal(0n);
    expect(await f.vault.holderBalance(c)).to.equal(nativeOut);
    expect(await f.vault.quoteLiabilities(await quote.getAddress())).to.equal(0n);
    await f.invariant();
  });

  it("a paused stock-like quote strands the vault share in the locker; it is pulled and attributed only from excess", async function () {
    const f = await base();
    const quote = await (await ethers.getContractFactory("MockBlockableERC20")).deploy();
    await quote.mint(f.admin.address, 10n ** 30n);
    const { campaign, token } = await f.campaignWith(HOLDERS);
    const g = await f.graduate(campaign, token, quote, true);
    await g.fundFees(0n, 10n * E18);
    await quote.setBlocked(await f.vault.getAddress(), false);
    await f.locker.harvest(await g.pair.getAddress());
    expect(await f.locker.pendingToken(await f.vault.getAddress(), await quote.getAddress())).to.equal(8n * E18);
    await quote.setBlocked(ethers.ZeroAddress, false);
    expect(await f.vault.syncLpFees.staticCall(await g.pair.getAddress())).to.equal(0n);
    await f.vault.syncLpFees(await g.pair.getAddress()); // binds the pool and the quote
    await f.vault.pullLockerPending(await quote.getAddress());
    const c = await campaign.getAddress();
    await expect(f.vault.attributeExcessQuote(c, 8n * E18 + 1n)).to.be.revertedWithCustomError(f.vault, "Insufficient");
    await expect(f.vault.connect(f.operator).attributeExcessQuote(c, 8n * E18)).to.be.revertedWithCustomError(f.vault, "OnlyAdmin");
    await f.vault.attributeExcessQuote(c, 8n * E18);
    expect(await f.vault.holderQuoteBalance(c)).to.equal(8n * E18);
    await expect(f.vault.attributeExcessQuote(c, 1n)).to.be.revertedWithCustomError(f.vault, "Insufficient");
  });
});

describe("evmgen fees: CreatorRewardsVaultV2 holders batches", function () {
  it("propose debits, the admin can veto for 24h, execution funds the Safe-authorized distributor batch", async function () {
    const f = await base();
    const a = await f.campaignWith(HOLDERS);
    const b = await f.campaignWith(SPLIT, 50);
    const va = await f.tradeFee(a.campaign, 10n ** 16n);
    const vb = await f.tradeFee(b.campaign, 10n ** 16n);
    const hb = vb - (vb * 50n) / 100n;
    const ca = await a.campaign.getAddress();
    const cb = await b.campaign.getAddress();
    const root = ethers.keccak256("0x01");
    const id1 = ethers.id("holders-week-1");
    await expect(f.vault.connect(f.other).proposeHolderBatch(id1, root, 0, [ca], [va])).to.be.revertedWithCustomError(f.vault, "OnlyOperator");
    await expect(f.vault.connect(f.operator).proposeHolderBatch(id1, root, 0, [ca], [va + 1n])).to.be.revertedWithCustomError(f.vault, "Insufficient");
    const keep = await f.campaignWith(KEEP);
    await f.tradeFee(keep.campaign, 10n ** 16n);
    await expect(f.vault.connect(f.operator).proposeHolderBatch(id1, root, 0, [await keep.campaign.getAddress()], [1n])).to.be.revertedWithCustomError(f.vault, "WrongChoice");

    await f.vault.connect(f.operator).proposeHolderBatch(id1, root, 0, [ca, cb], [va, hb]);
    expect(await f.vault.holderBalance(ca)).to.equal(0n);
    // Audit fix F5: nothing executes until the Safe approves this exact root and total.
    await expect(f.vault.connect(f.operator).executeHolderBatch(id1)).to.be.revertedWithCustomError(f.vault, "NotApproved");
    await expect(f.vault.connect(f.operator).approveHolderBatch(id1, root, va + hb)).to.be.revertedWithCustomError(f.vault, "OnlyAdmin");
    await expect(f.vault.approveHolderBatch(id1, ethers.keccak256("0x09"), va + hb)).to.be.revertedWithCustomError(f.vault, "BadBatch");
    await expect(f.vault.approveHolderBatch(id1, root, va + hb - 1n)).to.be.revertedWithCustomError(f.vault, "BadBatch");
    await f.vault.approveHolderBatch(id1, root, va + hb);
    await expect(f.vault.connect(f.operator).executeHolderBatch(id1)).to.be.revertedWithCustomError(f.vault, "TooSoon");
    await expect(f.vault.connect(f.operator).vetoHolderBatch(id1)).to.be.revertedWithCustomError(f.vault, "OnlyAdmin");
    await f.vault.vetoHolderBatch(id1);
    expect(await f.vault.holderBalance(ca)).to.equal(va);
    expect(await f.vault.holderBalance(cb)).to.equal(hb);
    await expect(f.vault.connect(f.operator).executeHolderBatch(id1)).to.be.revertedWithCustomError(f.vault, "BadBatch");

    const id2 = ethers.id("holders-week-1b");
    await f.vault.connect(f.operator).proposeHolderBatch(id2, root, 0, [ca, cb], [va, hb]);
    await f.vault.approveHolderBatch(id2, root, va + hb);
    await increase(DAY);
    // Not authorized by the Safe on the distributor: execution reverts atomically.
    await expect(f.vault.connect(f.operator).executeHolderBatch(id2)).to.be.revertedWithCustomError(f.distributor, "BatchNotAuthorized");
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await f.distributor.authorizeBatch(id2, va + hb, now - 10, now + 7 * DAY);
    const liab = await f.vault.totalLiabilities();
    await f.vault.connect(f.operator).executeHolderBatch(id2);
    expect((await f.distributor.batches(id2)).totalFunded).to.equal(va + hb);
    expect(await f.vault.totalLiabilities()).to.equal(liab - va - hb);
    await f.invariant();
  });

  it("enforces the weekly holder cap and the Safe's max on the distributor", async function () {
    const f = await base();
    await f.vault.setCaps(E18, 3n * E18, 3600, 50, 10n ** 15n);
    const a = await f.campaignWith(HOLDERS);
    const va = await f.tradeFee(a.campaign, 10n ** 17n); // 5.6e15 > weekly cap 1e15
    const ca = await a.campaign.getAddress();
    const root = ethers.keccak256("0x02");
    await expect(f.vault.connect(f.operator).proposeHolderBatch(ethers.id("x"), root, 0, [ca], [va])).to.be.revertedWithCustomError(f.vault, "CapExceeded");
    await f.vault.connect(f.operator).proposeHolderBatch(ethers.id("x"), root, 0, [ca], [10n ** 15n]);
    await f.vault.approveHolderBatch(ethers.id("x"), root, 10n ** 15n);
    await increase(DAY);
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await f.distributor.authorizeBatch(ethers.id("x"), 10n ** 15n - 1n, now - 10, now + DAY);
    await expect(f.vault.connect(f.operator).executeHolderBatch(ethers.id("x"))).to.be.revertedWithCustomError(f.distributor, "BatchAboveAuthorizedMax");
  });
});

describe("evmgen fees: CreatorRewardsVaultV2 buyback", function () {
  async function buybackSetup(target = 100n * E18) {
    const f = await base();
    const { campaign, token } = await f.campaignWith(BUYBACK, 0, target);
    await f.tradeFee(campaign, 30n * E18); // 1.68 native into the buyback balance
    return { ...f, campaign, token };
  }

  it("curve buyback: signed buy with actor = vault, refund and re-entrant fee accrual reconcile, tokens held", async function () {
    const f = await buybackSetup();
    const c = await f.campaign.getAddress();
    const sig = "0x1234";
    await f.campaign.setExpectedSig(sig);
    await f.campaign.setMaxCostPerBuy(E18 / 2n); // forces a refund
    const bal0 = await f.vault.buybackBalance(c);
    const amountIn = E18;
    const [, total, fee] = await f.campaign.quoteBuyExactBnb(amountIn);
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
    await expect(f.vault.connect(f.trader).buybackCurve(c, amountIn, 0, deadline, sig)).to.be.revertedWithCustomError(f.vault, "OnlyOperator");
    await f.vault.connect(f.operator).buybackCurve(c, amountIn, 0, deadline, sig);
    const accrued = (fee * 560n) / 10000n;
    expect(await f.vault.buybackBalance(c)).to.equal(bal0 - total + accrued);
    expect(await f.vault.heldBuybackTokens(c)).to.equal(await f.token.balanceOf(await f.vault.getAddress()));
    expect(await f.vault.heldBuybackTokens(c)).to.be.gt(0n);
    await f.invariant();
    // Held tokens cannot move before graduation; the flush waits for tradingEnabled, then goes to DEAD.
    await expect(f.vault.flushBuybackTokens(c)).to.be.revertedWithCustomError(f.vault, "CurveState");
    await f.campaign.graduate();
    const held = await f.vault.heldBuybackTokens(c);
    await f.vault.connect(f.other).flushBuybackTokens(c);
    expect(await f.token.balanceOf(DEAD)).to.equal(held);
    await expect(f.vault.rescueExcessToken(await f.token.getAddress(), f.admin.address, 0n)).to.be.revertedWithCustomError(f.vault, "Blocked");
  });

  it("curve buyback refuses the anti-sniper window, 95% progress, graduation-close state, impact, interval and caps", async function () {
    const f = await buybackSetup();
    const c = await f.campaign.getAddress();
    const deadline = () => ethers.provider.getBlock("latest").then((b) => b!.timestamp + 600);
    await f.campaign.setExpectedSig("0x01");
    await f.campaign.setFeeBps(5000);
    await expect(f.vault.connect(f.operator).buybackCurve(c, E18 / 10n, 0, await deadline(), "0x01")).to.be.revertedWithCustomError(f.vault, "CurveState");
    await f.campaign.setFeeBps(260);
    await expect(f.vault.connect(f.operator).buybackCurve(c, E18 / 10n, 0, await deadline(), "0x01")).to.be.revertedWithCustomError(f.vault, "CurveState");
    await f.campaign.setFeeBps(200);
    await f.campaign.setTarget(E18); // 0.96 in would pass 95% of a 1 native target
    await expect(f.vault.connect(f.operator).buybackCurve(c, (E18 * 96n) / 100n, 0, await deadline(), "0x01")).to.be.revertedWithCustomError(f.vault, "CurveState");
    await f.campaign.setTarget(100n * E18);
    await expect(f.vault.connect(f.operator).buybackCurve(c, E18 + 1n, 0, await deadline(), "0x01")).to.be.revertedWithCustomError(f.vault, "CapExceeded");
    await f.campaign.setSlope(10n ** 16n); // steep curve: a 1 native buy moves the price > 0.5%
    await expect(f.vault.connect(f.operator).buybackCurve(c, E18, 0, await deadline(), "0x01")).to.be.revertedWithCustomError(f.vault, "ImpactTooHigh");
    await f.campaign.setSlope(1000n);
    await f.vault.connect(f.operator).buybackCurve(c, E18 / 10n, 0, await deadline(), "0x01");
    await f.campaign.setExpectedSig("0x02");
    await expect(f.vault.connect(f.operator).buybackCurve(c, E18 / 10n, 0, await deadline(), "0x02")).to.be.revertedWithCustomError(f.vault, "TooSoon");
    await increase(3600);
    await f.vault.connect(f.operator).buybackCurve(c, E18 / 10n, 0, await deadline(), "0x02");
    // week cap 3 native: fund more and exhaust it
    await f.tradeFee(f.campaign, 100n * E18);
    for (let i = 3; i < 30; i++) {
      await increase(3600);
      await f.campaign.setExpectedSig("0x" + i.toString(16).padStart(2, "0"));
      const tx = f.vault.connect(f.operator).buybackCurve(c, E18, 0, await deadline(), "0x" + i.toString(16).padStart(2, "0"));
      try {
        await tx;
      } catch (e: any) {
        expect(String(e.message)).to.match(/CapExceeded|CurveState/);
        break;
      }
    }
    expect(await f.vault.buybackSpentInWeek(c)).to.be.lte(3n * E18);
    await f.invariant();
  });

  it("curve buyback reverts entirely (buy included) if the buy put the curve into graduation", async function () {
    const f = await buybackSetup();
    const c = await f.campaign.getAddress();
    await f.campaign.setExpectedSig("0x01");
    await f.campaign.setForceGraduationOnBuy(true);
    const bal = await f.vault.buybackBalance(c);
    await expect(
      f.vault.connect(f.operator).buybackCurve(c, E18 / 10n, 0, (await ethers.provider.getBlock("latest"))!.timestamp + 60, "0x01"),
    ).to.be.revertedWithCustomError(f.vault, "CurveState");
    expect(await f.campaign.graduationPending()).to.equal(false);
    expect(await f.vault.buybackBalance(c)).to.equal(bal);
  });

  it("pool buyback after graduation (native pool): WBNB in, MEME to DEAD, bounded to 0.5% impact; quote coin via conversion", async function () {
    const f = await buybackSetup();
    const c = await f.campaign.getAddress();
    await f.wrapped(300n * E18);
    const g = await f.graduate(f.campaign, f.token, f.weth, true);
    await expect(f.vault.connect(f.operator).buybackPool(c, E18 / 10n)).to.be.revertedWithCustomError(f.vault, "PoolMismatch");
    await f.vault.syncLpFees(await g.pair.getAddress()); // binds
    const [r0, r1] = await g.pair.getReserves();
    const rNative = g.memeIs0 ? r1 : r0;
    const cap = (rNative * 50n) / 20000n; // 0.25 native of 100
    const bal = await f.vault.buybackBalance(c);
    const deadBefore = await f.token.balanceOf(DEAD);
    await f.vault.connect(f.operator).buybackPool(c, E18); // more than the cap: partial
    expect(await f.vault.buybackBalance(c)).to.equal(bal - cap);
    expect(await f.token.balanceOf(DEAD)).to.be.gt(deadBefore);
    expect(await f.weth.balanceOf(await f.vault.getAddress())).to.equal(0n);
    await f.invariant();
    await expect(f.vault.connect(f.operator).buybackPool(c, E18 / 10n)).to.be.revertedWithCustomError(f.vault, "TooSoon");
  });

  it("E10 quote-bound buyback: native -> quote through the route, then quote -> MEME to DEAD in the coin's pool", async function () {
    const f = await buybackSetup();
    const c = await f.campaign.getAddress();
    const quote = await (await ethers.getContractFactory("MockERC20")).deploy("Quote", "USDX", 10n ** 30n, f.admin.address);
    const g = await f.graduate(f.campaign, f.token, quote, true);
    await f.vault.syncLpFees(await g.pair.getAddress());
    expect((await f.vault.cfg(c)).quote).to.equal(await quote.getAddress());
    const route = await (await ethers.getContractFactory("MockTopazPairEvmGen")).deploy();
    await f.topazFactory.setPool(await quote.getAddress(), await f.weth.getAddress(), false, await route.getAddress());
    await f.wrapped(1_000n * E18);
    await quote.approve(await route.getAddress(), ethers.MaxUint256);
    await f.weth.approve(await route.getAddress(), ethers.MaxUint256);
    const qIs0 = (await route.token0()).toLowerCase() === (await quote.getAddress()).toLowerCase();
    await route.seed(qIs0 ? 2_000_000n * E18 : 1_000n * E18, qIs0 ? 1_000n * E18 : 2_000_000n * E18);
    await route.setTwapFollowsSpot(true); // pool with TWAP history at spot (fix F3/F4: the TWAP guard fails closed)
    await f.vault.setQuoteRoute(await quote.getAddress(), 0);
    const quoteOut = await route.getAmountOut(E18 / 2n, await f.weth.getAddress());
    await f.vault.connect(f.operator).convertBuybackNativeToQuote(c, E18 / 2n);
    expect(await f.vault.buybackQuoteBalance(c)).to.equal(quoteOut);
    await increase(3600);
    const deadBefore = await f.token.balanceOf(DEAD);
    const [q0, q1] = await g.pair.getReserves();
    const quoteCap = ((g.memeIs0 ? q1 : q0) * 50n) / 20000n; // 0.25% of the pool's quote reserve
    const spend = quoteOut < quoteCap ? quoteOut : quoteCap;
    const memeOut = await g.pair.getAmountOut(spend, await quote.getAddress());
    await f.vault.connect(f.operator).buybackPool(c, quoteOut);
    expect((await f.token.balanceOf(DEAD)) - deadBefore).to.equal(memeOut);
    expect(await f.vault.buybackQuoteBalance(c)).to.equal(quoteOut - spend);
    expect(await quote.balanceOf(await f.vault.getAddress())).to.equal(await f.vault.quoteLiabilities(await quote.getAddress()));
    await f.invariant();
  });
});

describe("evmgen fees: CreatorRewardsVaultV2 operator bounds and rescue", function () {
  it("the operator can never receive value; a paused or replaced operator can do nothing", async function () {
    const f = await base();
    const { campaign, token } = await f.campaignWith(BUYBACK);
    await f.tradeFee(campaign, 30n * E18);
    const c = await campaign.getAddress();
    await campaign.setExpectedSig("0xaa");
    const opBefore = await ethers.provider.getBalance(f.operator.address);
    let gas = 0n;
    const deadline = (await ethers.provider.getBlock("latest"))!.timestamp + 600;
    const rc = await (await f.vault.connect(f.operator).buybackCurve(c, E18 / 2n, 0, deadline, "0xaa")).wait();
    gas += rc!.gasUsed * rc!.gasPrice;
    expect(await ethers.provider.getBalance(f.operator.address)).to.equal(opBefore - gas);
    expect(await token.balanceOf(f.operator.address)).to.equal(0n);
    await f.vault.setOperator(f.operator.address, true);
    await campaign.setExpectedSig("0xab");
    await increase(3600);
    await expect(f.vault.connect(f.operator).buybackCurve(c, E18 / 10n, 0, deadline + 7200, "0xab")).to.be.revertedWithCustomError(f.vault, "OnlyOperator");
    await f.vault.setOperator(f.other.address, false);
    await expect(f.vault.connect(f.operator).buybackCurve(c, E18 / 10n, 0, deadline + 7200, "0xab")).to.be.revertedWithCustomError(f.vault, "OnlyOperator");
    // Every operator entry point takes no recipient: the ABI proves it.
    for (const fn of ["buybackCurve", "buybackPool", "convertBuybackNativeToQuote", "convertHolderQuote", "proposeHolderBatch", "executeHolderBatch"]) {
      const frag = f.vault.interface.getFunction(fn)!;
      expect(frag.inputs.map((i) => i.name)).to.not.include.members(["to", "recipient"]);
    }
  });

  it("rescue moves only the excess; donations from anyone else are refused at the door", async function () {
    const f = await base();
    const { campaign } = await f.campaignWith(KEEP);
    const v = await f.tradeFee(campaign, 10n ** 16n);
    await expect(f.other.sendTransaction({ to: await f.vault.getAddress(), value: 1n })).to.be.reverted;
    // Force-feed via selfdestruct-less path: a campaign refund is accepted (the only non-weth native sender).
    await expect(f.vault.rescueExcessNative(f.admin.address, 1n)).to.be.revertedWithCustomError(f.vault, "Insufficient");
    await expect(f.vault.connect(f.operator).rescueExcessNative(f.operator.address, 0n)).to.be.revertedWithCustomError(f.vault, "OnlyAdmin");
    await expect(f.vault.rescueExcessToken(await f.weth.getAddress(), f.admin.address, 0n)).to.be.revertedWithCustomError(f.vault, "Blocked");
    await campaign.connect(f.trader).payFee(1, { value: 1n }); // rounds to 0 creator: nothing accrues
    expect(await f.vault.creatorBalance(await campaign.getAddress())).to.equal(v);
    await f.invariant();
  });
});
