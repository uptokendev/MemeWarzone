import { expect } from "chai";
import { ethers, network } from "hardhat";

// Internal-audit fixes on the fee stack (docs/evm-launch/spec/C1-C6-fees.md, "Internal-audit fixes").
// The audit specs keep the attacks; this file pins the new rules directly, per fix.
const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;
const DAY = 86400;

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

async function increase(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

/** Uniswap V3 locker with one registered MEME/WETH pool (as evmgen-fees-locker-v3). */
async function v3Locker() {
  const [owner, creator, recipient, campaign] = await ethers.getSigners();
  await ethers.provider.send("hardhat_setBalance", [owner.address, "0x" + (10n ** 24n).toString(16)]);
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  await weth.deposit({ value: 3_000n * E18 });
  const meme = await (await ethers.getContractFactory("MockERC20")).deploy("Meme", "MEME", 10n ** 30n, owner.address);
  const v3f = await (await ethers.getContractFactory("MockUniswapV3FactoryEvmGen")).deploy();
  const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManagerEvmGen")).deploy();
  const pool = await (await ethers.getContractFactory("MockUniswapV3PoolEvmGen")).deploy(await meme.getAddress(), await weth.getAddress(), 3000);
  await v3f.setPool(await meme.getAddress(), await weth.getAddress(), 3000, await pool.getAddress());
  const memeIs0 = (await pool.token0()).toLowerCase() === (await meme.getAddress()).toLowerCase();
  const memeRes = 1_000_000n * E18;
  const pairedRes = 1_000n * E18;
  const sqrtP = memeIs0 ? isqrt((pairedRes * Q96 * Q96) / memeRes) : isqrt((memeRes * Q96 * Q96) / pairedRes);
  await pool.setup(await npm.getAddress(), sqrtP, isqrt(memeRes * pairedRes));
  await meme.transfer(await pool.getAddress(), memeRes * 2n);
  await weth.transfer(await pool.getAddress(), pairedRes * 2n);
  const integration = await (await ethers.getContractFactory("MockV3IntegrationEvmGen")).deploy(await v3f.getAddress(), await npm.getAddress(), await weth.getAddress());
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const protocolVault = await Receiver.deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(owner.address, await weekly.getAddress(), await weekly.getAddress(), 3600);
  await router.setProtocolRevenueVault(await protocolVault.getAddress());
  const locker = await (await ethers.getContractFactory("PermanentV3PositionLocker")).deploy(owner.address);
  await locker.configureRevenue(await router.getAddress(), await integration.getAddress());
  await router.setAuthorizedLpLocker(await locker.getAddress(), true);
  await npm.mintPosition(await integration.getAddress(), await pool.getAddress());
  await integration.deliver(await locker.getAddress(), 1n);
  await locker.registerGraduatedPool(campaign.address, creator.address, recipient.address, await pool.getAddress(), await meme.getAddress(), await weth.getAddress(), 0n);
  await meme.approve(await pool.getAddress(), ethers.MaxUint256);
  await weth.approve(await pool.getAddress(), ethers.MaxUint256);
  async function fundMemeFees(amount: bigint) {
    await pool.accrueFees(memeIs0 ? amount : 0n, memeIs0 ? 0n : amount);
  }
  return { owner, creator, recipient, campaign, meme, weth, pool, locker, npm, integration, v3f, memeIs0, fundMemeFees };
}

describe("audit fix F2: one MEME sale per pool per block", function () {
  it("V3 locker: a loop of harvests in one transaction sells once; the next block sells again", async function () {
    const f = await v3Locker();
    const pool = await f.pool.getAddress();
    await f.fundMemeFees(30_000n * E18); // 3% of the in-range MEME: far above one 0.50% bound
    const attacker = await (await ethers.getContractFactory("Audit4Attacker")).deploy();
    const sp0 = await f.pool.sqrtPriceX96();
    await attacker.loopHarvest(await f.locker.getAddress(), pool, 8);
    const sp1 = await f.pool.sqrtPriceX96();
    const carried1 = await f.locker.carriedMeme(pool);
    expect(carried1).to.be.gt(0n);
    // The price moved by one bound only (<= 0.50% on the MEME price), not 8 compounding bounds.
    const ratio = f.memeIs0 ? (sp1 * sp1 * 10000n) / (sp0 * sp0) : (sp0 * sp0 * 10000n) / (sp1 * sp1);
    expect(ratio).to.be.gte(9950n);
    expect(await f.locker.lastSaleBlock(pool)).to.equal(BigInt((await ethers.provider.getBlock("latest"))!.number));
    // A later block sells again from the carried amount.
    await f.locker.harvest(pool);
    expect(await f.locker.carriedMeme(pool)).to.be.lt(carried1);
  });
});

/** BNB-style vault stack (Topaz V2), as audit4-fees.spec.ts. */
async function bnbVault() {
  const [admin, operator, creator, trader, other] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const r = await Receiver.deploy();
  const community = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(admin.address, await r.getAddress(), await r.getAddress(), 3600);
  const vault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(admin.address, await router.getAddress(), await weth.getAddress(), 1, await topazFactory.getAddress(), DAY);
  await router.setRecruiterRewardsVault(await r.getAddress());
  await router.setCommunityRewardsVault(await community.getAddress());
  await router.setProtocolRevenueVault(await r.getAddress());
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
  await vault.setCaps(10n * E18, 30n * E18, 3600, 50, 10n * E18);

  async function campaignWith(choice: number, pct = 0) {
    const campaign = await (await ethers.getContractFactory("MockCampaignEvmGen")).deploy(await router.getAddress(), 100n * E18);
    await factory.addCampaign(await campaign.getAddress());
    await factory.choose(await vault.getAddress(), await campaign.getAddress(), creator.address, choice, pct);
    const token = await ethers.getContractAt("MockLaunchTokenEvmGen", await campaign.token());
    return { campaign, token, c: await campaign.getAddress() };
  }
  async function graduate(campaign: any, token: any, paired: any, memeRes = 1_000_000n * E18, pairedRes = 100n * E18) {
    await campaign.graduate();
    await campaign.mintTo(admin.address, 2n * memeRes);
    const pair = await (await ethers.getContractFactory("MockTopazPairEvmGen")).deploy();
    await topazFactory.setPool(await token.getAddress(), await paired.getAddress(), false, await pair.getAddress());
    await token.approve(await pair.getAddress(), ethers.MaxUint256);
    await paired.approve(await pair.getAddress(), ethers.MaxUint256);
    const memeIs0 = (await pair.token0()).toLowerCase() === (await token.getAddress()).toLowerCase();
    await pair.seed(memeIs0 ? memeRes : pairedRes, memeIs0 ? pairedRes : memeRes);
    await pair.setTwapFollowsSpot(true);
    await pair.mint(await locker.getAddress(), E18);
    const c = await campaign.getAddress();
    await locker.registerGraduatedPool(c, c, await vault.getAddress(), await pair.getAddress(), await token.getAddress(), await paired.getAddress(), E18);
    async function fundFees(memeFee: bigint, pairedFee: bigint) {
      await pair.fundFees(await locker.getAddress(), memeIs0 ? memeFee : pairedFee, memeIs0 ? pairedFee : memeFee);
    }
    return { pair, memeIs0, fundFees };
  }
  return { admin, operator, creator, trader, other, weth, topazFactory, router, vault, locker, factory, distributor, campaignWith, graduate };
}

describe("audit fix F4: vault swaps scale the impact bound to the pool fee and fail closed without a TWAP", function () {
  it("feeScaledImpact = min(bound, fee * 5/3) for every V3 tier and Topaz fee", async function () {
    const h = await (await ethers.getContractFactory("EvmGenPoolSwapHarness")).deploy();
    expect(await h.feeScaledImpact(50, 10_000)).to.equal(50n); // 1%
    expect(await h.feeScaledImpact(50, 3_000)).to.equal(50n); // 0.30%
    expect(await h.feeScaledImpact(50, 500)).to.equal(8n); // 0.05%
    expect(await h.feeScaledImpact(50, 100)).to.equal(1n); // 0.01%
    expect(await h.feeScaledImpact(50, 0)).to.equal(0n);
    expect(await h.feeScaledImpact(20, 3_000)).to.equal(20n); // the admin's tighter cap still wins
    expect(await h.feeScaledImpact(50, 5 * 100)).to.equal(8n); // Topaz 5 bps, passed as pips
  });

  it("V2 (Topaz): a 5 bps pool's buyback sells at most 8 bps / 2 of the reserve, not 50 / 2", async function () {
    const f = await bnbVault();
    const k = await f.campaignWith(4 /* Buyback */);
    await k.campaign.connect(f.trader).payFee(1, { value: 200n * E18 }); // 11.2 native to buyback
    await f.weth.deposit({ value: 300n * E18 });
    const g = await f.graduate(k.campaign, k.token, f.weth);
    await f.vault.syncLpFees(await g.pair.getAddress());
    await f.topazFactory.setFeeBps(5);
    const bal = await f.vault.buybackBalance(k.c);
    await f.vault.connect(f.operator).buybackPool(k.c, 5n * E18);
    const spent = bal - (await f.vault.buybackBalance(k.c));
    expect(spent).to.equal((100n * E18 * 8n) / 20000n); // 0.04 WETH of the 100 WETH reserve
  });

  it("V2 and V3 TWAP guards fail closed when the pool cannot serve a TWAP", async function () {
    const h = await (await ethers.getContractFactory("EvmGenPoolSwapHarness")).deploy();
    const f = await v3Locker();
    // V3: observe reverts (no history) -> not ok; with history at spot -> ok; the locker's no-window call is unaffected.
    expect((await h.v3LimitTwap(await f.pool.getAddress(), true, 50, 100, 1800)).ok).to.equal(false);
    expect((await h.v3LimitTwap(await f.pool.getAddress(), true, 50, 100, 0)).ok).to.equal(true);
    await f.pool.setTwap(true, 0);
    expect((await h.v3LimitTwap(await f.pool.getAddress(), true, 50, 100, 1800)).ok).to.equal(true);
    // V2: quote reverts -> nothing to sell when a band is asked for; without a band (dev 0) the plan is unchanged.
    const Token = await ethers.getContractFactory("MockERC20");
    const [owner] = await ethers.getSigners();
    const a = await Token.deploy("A", "A", 10n ** 30n, owner.address);
    const b = await Token.deploy("B", "B", 10n ** 30n, owner.address);
    const topaz = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const pair = await (await ethers.getContractFactory("MockTopazPairEvmGen")).deploy();
    await topaz.setPool(await a.getAddress(), await b.getAddress(), false, await pair.getAddress());
    await a.approve(await pair.getAddress(), ethers.MaxUint256);
    await b.approve(await pair.getAddress(), ethers.MaxUint256);
    await pair.seed(1_000n * E18, 1_000n * E18);
    expect((await h.v2Plan(await pair.getAddress(), await a.getAddress(), E18, 50, 100)).sellIn).to.equal(0n);
    expect((await h.v2Plan(await pair.getAddress(), await a.getAddress(), E18, 50, 0)).sellIn).to.equal(E18);
    await pair.setTwapFollowsSpot(true);
    expect((await h.v2Plan(await pair.getAddress(), await a.getAddress(), E18, 50, 100)).sellIn).to.equal(E18);
  });

  it("the interval is per route pool: conversions for two campaigns through one pool cannot share a block", async function () {
    const f = await bnbVault();
    const quote = await (await ethers.getContractFactory("MockERC20")).deploy("Quote", "USDX", 10n ** 30n, f.admin.address);
    const A = await f.campaignWith(4 /* Buyback */);
    const B = await f.campaignWith(4);
    await A.campaign.connect(f.trader).payFee(1, { value: 100n * E18 });
    await B.campaign.connect(f.trader).payFee(1, { value: 100n * E18 });
    const gA = await f.graduate(A.campaign, A.token, quote);
    const gB = await f.graduate(B.campaign, B.token, quote);
    await f.vault.syncLpFees(await gA.pair.getAddress());
    await f.vault.syncLpFees(await gB.pair.getAddress());
    // canonical WBNB/USDX route
    const route = await (await ethers.getContractFactory("MockTopazPairEvmGen")).deploy();
    await f.topazFactory.setPool(await f.weth.getAddress(), await quote.getAddress(), false, await route.getAddress());
    await f.weth.deposit({ value: 1_000n * E18 });
    await f.weth.approve(await route.getAddress(), ethers.MaxUint256);
    await quote.approve(await route.getAddress(), ethers.MaxUint256);
    const qIs0 = (await route.token0()).toLowerCase() === (await quote.getAddress()).toLowerCase();
    await route.seed(qIs0 ? 1_000_000n * E18 : 1_000n * E18, qIs0 ? 1_000n * E18 : 1_000_000n * E18);
    await route.setTwapFollowsSpot(true);
    await f.vault.setQuoteRoute(await quote.getAddress(), 0);
    await f.vault.connect(f.operator).convertBuybackNativeToQuote(A.c, E18 / 10n);
    await expect(f.vault.connect(f.operator).convertBuybackNativeToQuote(B.c, E18 / 10n)).to.be.revertedWithCustomError(f.vault, "TooSoon");
    await increase(3600);
    await f.vault.connect(f.operator).convertBuybackNativeToQuote(B.c, E18 / 10n);
  });
});

describe("audit fix F8: a creator's chosen payout wallet survives later registrations", function () {
  it("V2 locker: the second graduation of a Keep creator does not reset updateCreatorPayoutRecipient", async function () {
    const [owner, creator, , , chosen] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const topaz = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
    const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(owner.address);
    await locker.configureRevenue(owner.address, await topaz.getAddress());
    const weth = await Token.deploy("W", "W", 10n ** 30n, owner.address);
    async function pool() {
      const meme = await Token.deploy("M", "M", 10n ** 30n, owner.address);
      const pair = await (await ethers.getContractFactory("MockTopazPairEvmGen")).deploy();
      await topaz.setPool(await meme.getAddress(), await weth.getAddress(), false, await pair.getAddress());
      await pair.mint(await locker.getAddress(), E18);
      return { meme, pair };
    }
    const p1 = await pool();
    await locker.registerGraduatedPool(creator.address, creator.address, creator.address, await p1.pair.getAddress(), await p1.meme.getAddress(), await weth.getAddress(), E18);
    await locker.connect(creator).updateCreatorPayoutRecipient(chosen.address);
    const p2 = await pool();
    await locker.registerGraduatedPool(owner.address, creator.address, creator.address, await p2.pair.getAddress(), await p2.meme.getAddress(), await weth.getAddress(), E18);
    expect(await locker.creatorPayoutRecipient(creator.address)).to.equal(chosen.address);
  });

  it("V3 locker: the same, for Uniswap V3 positions", async function () {
    const f = await v3Locker();
    const [, , , , chosen] = await ethers.getSigners();
    await f.locker.connect(f.creator).updateCreatorPayoutRecipient(chosen.address);
    // a second coin by the same creator graduates
    const meme2 = await (await ethers.getContractFactory("MockERC20")).deploy("Meme2", "M2", 10n ** 30n, f.owner.address);
    const pool2 = await (await ethers.getContractFactory("MockUniswapV3PoolEvmGen")).deploy(await meme2.getAddress(), await f.weth.getAddress(), 3000);
    await f.v3f.setPool(await meme2.getAddress(), await f.weth.getAddress(), 3000, await pool2.getAddress());
    await pool2.setup(await f.npm.getAddress(), Q96, 10n ** 20n);
    const id = await f.npm.nextId();
    await f.npm.mintPosition(await f.integration.getAddress(), await pool2.getAddress());
    await f.integration.deliver(await f.locker.getAddress(), id);
    await f.locker.registerGraduatedPool(f.owner.address, f.creator.address, f.creator.address, await pool2.getAddress(), await meme2.getAddress(), await f.weth.getAddress(), 0n);
    expect(await f.locker.creatorPayoutRecipient(f.creator.address)).to.equal(chosen.address);
  });
});
