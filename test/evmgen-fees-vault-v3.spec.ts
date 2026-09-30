import { expect } from "chai";
import { ethers, network } from "hardhat";

// CreatorRewardsVaultV2 on Robinhood (dexKind 2, Uniswap V3): pool buyback, TWAP guard, stock -> native route.
const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const HOLDERS = 2, BUYBACK = 4;

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

async function setup() {
  const [admin, operator, creator, trader] = await ethers.getSigners();
  await network.provider.send("hardhat_setBalance", [admin.address, "0x" + (10n ** 25n).toString(16)]);
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  await weth.deposit({ value: 10_000n * E18 });
  const v3f = await (await ethers.getContractFactory("MockUniswapV3FactoryEvmGen")).deploy();
  const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManagerEvmGen")).deploy();
  const integration = await (await ethers.getContractFactory("MockV3IntegrationEvmGen")).deploy(await v3f.getAddress(), await npm.getAddress(), await weth.getAddress());
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const r = await Receiver.deploy();
  const community = await (await ethers.getContractFactory("CommunityRewardsVaultV3Mock")).deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(admin.address, await r.getAddress(), await r.getAddress(), 3600);
  const vault = await (await ethers.getContractFactory("CreatorRewardsVaultV2")).deploy(admin.address, await router.getAddress(), await weth.getAddress(), 2, await v3f.getAddress(), 86400);
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
  async function graduated(choice: number, paired: any) {
    const campaign = await (await ethers.getContractFactory("MockCampaignEvmGen")).deploy(await router.getAddress(), 100n * E18);
    await factory.addCampaign(await campaign.getAddress());
    await factory.choose(await vault.getAddress(), await campaign.getAddress(), creator.address, choice, 0);
    await campaign.connect(trader).payFee(1, { value: 200n * E18 });
    const token = await ethers.getContractAt("MockLaunchTokenEvmGen", await campaign.token());
    await campaign.graduate();
    await campaign.mintTo(admin.address, 3_000_000n * E18);
    const pool = await makePool(token, paired, 3000, 1_000_000n * E18, 1_000n * E18);
    const id = await npm.nextId();
    await npm.mintPosition(await integration.getAddress(), await pool.getAddress());
    await integration.deliver(await locker.getAddress(), id);
    const c = await campaign.getAddress();
    await locker.registerGraduatedPool(c, c, await vault.getAddress(), await pool.getAddress(), await token.getAddress(), await paired.getAddress(), 0n);
    await vault.syncLpFees(await pool.getAddress());
    return { campaign, token, pool, c };
  }
  return { admin, operator, creator, weth, v3f, npm, vault, locker, graduated, makePool };
}

describe("evmgen fees: CreatorRewardsVaultV2 on Uniswap V3 (Robinhood)", function () {
  it("pool buyback: WETH in, MEME to DEAD, the pool stops at 0.5% impact, leftover unwrapped back to the balance", async function () {
    const f = await setup();
    const g = await f.graduated(BUYBACK, f.weth);
    const bal = await f.vault.buybackBalance(g.c);
    const sp0 = await g.pool.sqrtPriceX96();
    await f.vault.setCaps(10n * E18, 30n * E18, 3600, 50, 10n * E18);
    await f.vault.connect(f.operator).buybackPool(g.c, 5n * E18); // 5 native vs a 1000-native pool: hits the 0.5% limit
    const sp1 = await g.pool.sqrtPriceX96();
    const memeIs0 = (await g.pool.token0()).toLowerCase() === (await g.token.getAddress()).toLowerCase();
    // MEME price in WETH rises by <= 0.5%
    const pr = memeIs0 ? (sp1 * sp1 * 10n ** 6n) / (sp0 * sp0) : (sp0 * sp0 * 10n ** 6n) / (sp1 * sp1);
    expect(pr).to.be.lte(1_005_000n);
    const spent = bal - (await f.vault.buybackBalance(g.c));
    expect(spent).to.be.gt(0n);
    expect(spent).to.be.lt(5n * E18);
    expect(await g.token.balanceOf(DEAD)).to.be.gt(0n);
    expect(await f.weth.balanceOf(await f.vault.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await f.vault.getAddress())).to.be.gte(await f.vault.totalLiabilities());
    await expect(f.vault.uniswapV3SwapCallback(1n, 0n, "0x")).to.be.revertedWithCustomError(f.vault, "UnexpectedCallback");
  });

  it("refuses the swap while spot is worse than the TWAP by more than 1%", async function () {
    const f = await setup();
    const g = await f.graduated(BUYBACK, f.weth);
    const memeIs0 = (await g.pool.token0()).toLowerCase() === (await g.token.getAddress()).toLowerCase();
    // Buying MEME with WETH: bad when MEME spot is pumped above its TWAP. 200 ticks ~ 2%.
    await g.pool.setTick(memeIs0 ? 200 : -200);
    await g.pool.setTwap(true, 0);
    await expect(f.vault.connect(f.operator).buybackPool(g.c, E18 / 10n)).to.be.revertedWithCustomError(f.vault, "NothingSwapped");
    await g.pool.setTick(memeIs0 ? 50 : -50);
    await f.vault.connect(f.operator).buybackPool(g.c, E18 / 10n);
  });

  it("E10 holders coin on a stock pool: LP stock is credited, then converted to native through the admin-chosen fee tier", async function () {
    const f = await setup();
    const stock = await (await ethers.getContractFactory("MockERC20")).deploy("Stock", "STK", 10n ** 30n, f.admin.address);
    const g = await f.graduated(HOLDERS, stock);
    const memeIs0 = (await g.pool.token0()).toLowerCase() === (await g.token.getAddress()).toLowerCase();
    await stock.approve(await g.pool.getAddress(), ethers.MaxUint256);
    await g.pool.accrueFees(memeIs0 ? 0n : 5n * E18, memeIs0 ? 5n * E18 : 0n);
    await f.locker.harvest(await g.pool.getAddress());
    await f.vault.syncLpFees(await g.pool.getAddress());
    expect(await f.vault.holderQuoteBalance(g.c)).to.equal(4n * E18);
    await expect(f.vault.setQuoteRoute(await stock.getAddress(), 500)).to.be.revertedWithCustomError(f.vault, "NoRoute");
    await f.makePool(stock, f.weth, 500, 1_000_000n * E18, 100n * E18);
    await f.vault.setQuoteRoute(await stock.getAddress(), 500);
    const before = await f.vault.holderBalance(g.c);
    await f.vault.connect(f.operator).convertHolderQuote(g.c, 4n * E18);
    expect(await f.vault.holderQuoteBalance(g.c)).to.equal(0n);
    expect((await f.vault.holderBalance(g.c)) - before).to.be.gt(0n);
    expect(await ethers.provider.getBalance(await f.vault.getAddress())).to.be.gte(await f.vault.totalLiabilities());
    expect(await stock.balanceOf(await f.vault.getAddress())).to.equal(await f.vault.quoteLiabilities(await stock.getAddress()));
  });
});
