import { expect } from "chai";
import { ethers } from "hardhat";

// E9 on Robinhood: PermanentV3PositionLocker (new generation source) sells the MEME-side fees in the same
// Uniswap V3 pool with a sqrtPriceLimitX96 at 0.50% price impact (the pool stops the swap, the rest is
// carried) and splits only the paired asset 80/20.
const E18 = 10n ** 18n;
const Q96 = 2n ** 96n;

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

async function setup(opts: { stock?: boolean } = {}) {
  const [owner, creator, recipient, campaign, stranger] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockERC20");
  const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
  const meme = await Token.deploy("Meme", "MEME", 10n ** 30n, owner.address);
  const stock = await Token.deploy("Stock", "STK", 10n ** 30n, owner.address);
  const paired: any = opts.stock ? stock : weth;
  if (!opts.stock) { await ethers.provider.send("hardhat_setBalance", [owner.address, "0x" + (10n ** 24n).toString(16)]); } if (!opts.stock) await weth.deposit({ value: 3_000n * E18 });

  const v3f = await (await ethers.getContractFactory("MockUniswapV3FactoryEvmGen")).deploy();
  const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManagerEvmGen")).deploy();
  const pool = await (await ethers.getContractFactory("MockUniswapV3PoolEvmGen")).deploy(await meme.getAddress(), await paired.getAddress(), 3000);
  await v3f.setPool(await meme.getAddress(), await paired.getAddress(), 3000, await pool.getAddress());
  const memeIs0 = (await pool.token0()).toLowerCase() === (await meme.getAddress()).toLowerCase();

  // 1 MEME = 0.001 paired; 1M MEME in range.
  const memeRes = 1_000_000n * E18;
  const pairedRes = 1_000n * E18;
  const L = isqrt(memeRes * pairedRes);
  const sqrtP = memeIs0 ? isqrt((pairedRes * Q96 * Q96) / memeRes) : isqrt((memeRes * Q96 * Q96) / pairedRes);
  await pool.setup(await npm.getAddress(), sqrtP, L);
  await meme.transfer(await pool.getAddress(), memeRes * 2n);
  await paired.transfer(await pool.getAddress(), pairedRes * 2n);

  const integration = await (await ethers.getContractFactory("MockV3IntegrationEvmGen")).deploy(await v3f.getAddress(), await npm.getAddress(), await weth.getAddress());
  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const monthly = await Receiver.deploy();
  const protocolVault = await Receiver.deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(owner.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
  await router.setProtocolRevenueVault(await protocolVault.getAddress());
  const locker = await (await ethers.getContractFactory("PermanentV3PositionLocker")).deploy(owner.address);
  await locker.configureRevenue(await router.getAddress(), await integration.getAddress());
  await router.setAuthorizedLpLocker(await locker.getAddress(), true);

  await npm.mintPosition(await integration.getAddress(), await pool.getAddress());
  await integration.deliver(await locker.getAddress(), 1n);
  await locker.registerGraduatedPool(campaign.address, creator.address, recipient.address, await pool.getAddress(), await meme.getAddress(), await paired.getAddress(), 0n);

  await meme.approve(await pool.getAddress(), ethers.MaxUint256);
  await paired.approve(await pool.getAddress(), ethers.MaxUint256);
  async function fundFees(memeFee: bigint, pairedFee: bigint) {
    await pool.accrueFees(memeIs0 ? memeFee : pairedFee, memeIs0 ? pairedFee : memeFee);
  }
  // MEME price in paired, as sqrtPriceX96 squared ratio (1e18 fixed point)
  async function price() {
    const sp = await pool.sqrtPriceX96();
    const p01 = (sp * sp * E18) / (Q96 * Q96);
    return memeIs0 ? p01 : (E18 * E18) / p01;
  }
  return { owner, creator, recipient, campaign, stranger, meme, paired, weth, pool, locker, protocolVault, fundFees, price, memeIs0, npm, integration, v3f };
}

describe("evmgen fees: PermanentV3PositionLocker native-only harvest (E9, Uniswap V3)", function () {
  it("sells a small MEME fee in full and splits paired + proceeds exactly 80/20", async function () {
    const f = await setup();
    await f.fundFees(50n * E18, 2n * E18);
    const tx = await f.locker.harvest(await f.pool.getAddress());
    const rc = await tx.wait();
    const ev = rc!.logs.map((l: any) => { try { return f.locker.interface.parseLog(l); } catch { return null; } }).find((e: any) => e && e.name === "MemeFeesSold");
    expect(ev!.args.memeSold).to.equal(50n * E18);
    expect(ev!.args.memeCarried).to.equal(0n);
    const total = 2n * E18 + ev!.args.pairedOut;
    expect(await f.paired.balanceOf(f.recipient.address)).to.equal((total * 8000n) / 10000n);
    expect(await f.paired.balanceOf(await f.protocolVault.getAddress())).to.equal(total - (total * 8000n) / 10000n);
    expect(await f.meme.balanceOf(f.recipient.address)).to.equal(0n);
    expect(await f.meme.balanceOf(await f.locker.getAddress())).to.equal(0n);
    expect(await f.paired.balanceOf(await f.locker.getAddress())).to.equal(0n);
  });

  it("the pool stops the sale at 0.5% price impact; the rest is carried and sold over later harvests", async function () {
    const f = await setup();
    const memeFee = 20_000n * E18; // 2% of the range
    await f.fundFees(memeFee, 0n);
    const p0 = await f.price();
    await f.locker.harvest(await f.pool.getAddress());
    const p1 = await f.price();
    expect(p1).to.be.lt(p0);
    expect(((p0 - p1) * 1_000_000n) / p0).to.be.lte(5_000n); // <= 0.50%
    const carried = await f.locker.carriedMeme(await f.pool.getAddress());
    expect(carried).to.be.gt(0n);
    expect(await f.meme.balanceOf(await f.locker.getAddress())).to.equal(carried);
    let n = 1;
    while ((await f.locker.carriedMeme(await f.pool.getAddress())) > 0n) {
      const pb = await f.price();
      await f.locker.harvest(await f.pool.getAddress());
      const pa = await f.price();
      expect(((pb - pa) * 1_000_000n) / pb).to.be.lte(5_000n);
      n++;
      expect(n).to.be.lte(12);
    }
    expect(await f.meme.balanceOf(await f.locker.getAddress())).to.equal(0n);
    expect(await f.paired.balanceOf(await f.locker.getAddress())).to.equal(0n);
  });

  it("never reverts the harvest when the sale fails (empty liquidity): MEME carried, paired split", async function () {
    const f = await setup();
    await f.fundFees(10n * E18, 1n * E18);
    await f.pool.setup(await f.npm.getAddress(), await f.pool.sqrtPriceX96(), 0n);
    await f.locker.harvest(await f.pool.getAddress());
    expect(await f.locker.carriedMeme(await f.pool.getAddress())).to.equal(10n * E18);
    expect(await f.paired.balanceOf(f.recipient.address)).to.equal((1n * E18 * 8000n) / 10000n);
  });

  it("a stock-bound pool pays in the stock token only", async function () {
    const f = await setup({ stock: true });
    await f.fundFees(30n * E18, 4n * E18);
    await f.locker.harvest(await f.pool.getAddress());
    const paid = (await f.paired.balanceOf(f.recipient.address)) + (await f.paired.balanceOf(await f.protocolVault.getAddress()));
    expect(paid).to.be.gt(4n * E18);
    expect(await f.paired.balanceOf(f.recipient.address)).to.equal((paid * 8000n) / 10000n);
    expect(await f.meme.balanceOf(f.recipient.address)).to.equal(0n);
  });

  it("rejects a swap callback from anyone but the in-flight pool, and self-only sale entry", async function () {
    const f = await setup();
    await expect(f.locker.uniswapV3SwapCallback(1n, 0n, "0x")).to.be.revertedWithCustomError(f.locker, "UnexpectedCallback");
    await expect(f.locker.sellMemeForPaired(await f.pool.getAddress(), true, 1n)).to.be.revertedWithCustomError(f.locker, "OnlySelf");
  });

  it("refuses to register the wrapped native as the MEME side", async function () {
    const [owner, creator, recipient, campaign] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const meme = await Token.deploy("Meme", "MEME", 10n ** 30n, owner.address);
    const v3f = await (await ethers.getContractFactory("MockUniswapV3FactoryEvmGen")).deploy();
    const npm = await (await ethers.getContractFactory("MockUniswapV3PositionManagerEvmGen")).deploy();
    const pool = await (await ethers.getContractFactory("MockUniswapV3PoolEvmGen")).deploy(await meme.getAddress(), await weth.getAddress(), 3000);
    await v3f.setPool(await meme.getAddress(), await weth.getAddress(), 3000, await pool.getAddress());
    await pool.setup(await npm.getAddress(), Q96, 10n ** 20n);
    const integration = await (await ethers.getContractFactory("MockV3IntegrationEvmGen")).deploy(await v3f.getAddress(), await npm.getAddress(), await weth.getAddress());
    const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
    const r = await Receiver.deploy();
    const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(owner.address, await r.getAddress(), await r.getAddress(), 3600);
    const locker = await (await ethers.getContractFactory("PermanentV3PositionLocker")).deploy(owner.address);
    await locker.configureRevenue(await router.getAddress(), await integration.getAddress());
    await npm.mintPosition(await integration.getAddress(), await pool.getAddress());
    await integration.deliver(await locker.getAddress(), 1n);
    await expect(
      locker.registerGraduatedPool(campaign.address, creator.address, recipient.address, await pool.getAddress(), await weth.getAddress(), await meme.getAddress(), 0n),
    ).to.be.revertedWithCustomError(locker, "TokenPairMismatch");
  });

  it("conservation over a random sequence of fees and harvests", async function () {
    const f = await setup();
    let seed = 777n;
    let memeIn = 0n;
    let pairedIn = 0n;
    let pairedOut = 0n;
    let memeSold = 0n;
    for (let i = 0; i < 10; i++) {
      seed = (seed * 1103515245n + 12345n) % 2n ** 31n;
      const m = (seed % 4000n) * E18;
      const p = (seed % 5n) * E18;
      await f.fundFees(m, p);
      // What the harvest collects includes the position's own share of earlier sales' pool fee.
      const c0 = await f.pool.claimable0();
      const c1 = await f.pool.claimable1();
      memeIn += f.memeIs0 ? c0 : c1;
      pairedIn += f.memeIs0 ? c1 : c0;
      const rc = await (await f.locker.harvest(await f.pool.getAddress())).wait();
      for (const l of rc!.logs) {
        try {
          const e = f.locker.interface.parseLog(l as any);
          if (e && e.name === "MemeFeesSold") {
            pairedOut += e.args.pairedOut;
            memeSold += e.args.memeSold;
          }
        } catch {}
      }
      const carried = await f.locker.carriedMeme(await f.pool.getAddress());
      expect(await f.meme.balanceOf(await f.locker.getAddress())).to.equal(carried);
      expect(await f.paired.balanceOf(await f.locker.getAddress())).to.equal(0n);
    }
    expect(memeSold + (await f.locker.carriedMeme(await f.pool.getAddress()))).to.equal(memeIn);
    const paid = (await f.paired.balanceOf(f.recipient.address)) + (await f.paired.balanceOf(await f.protocolVault.getAddress()));
    expect(paid).to.equal(pairedIn + pairedOut);
  });
});
