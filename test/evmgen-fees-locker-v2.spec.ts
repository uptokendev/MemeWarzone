import { expect } from "chai";
import { ethers } from "hardhat";

// E9 on BNB: PermanentLpLocker (new generation source) sells the MEME-side LP fees for the paired asset in the
// same Topaz pair, bounded to 0.50% price impact (<= 0.25% of the MEME reserve) per harvest, carries the rest,
// and splits only the paired asset 80/20. Spec docs/evm-launch/spec/C1-C6-fees.md, plan E9.
const E18 = 10n ** 18n;
const RESERVE_MEME = 1_000_000n * E18;
const RESERVE_PAIRED = 1_000n * E18;

async function setup(opts: { quote?: boolean } = {}) {
  const [owner, creator, recipient, attacker, stranger] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockERC20");
  const meme = await Token.deploy("Meme", "MEME", 10n ** 30n, owner.address);
  const paired = await Token.deploy(opts.quote ? "Quote" : "Wrapped BNB", opts.quote ? "USDX" : "WBNB", 10n ** 30n, owner.address);
  const topazFactory = await (await ethers.getContractFactory("MockTopazFactory")).deploy();
  const pair = await (await ethers.getContractFactory("MockTopazPairEvmGen")).deploy();
  await topazFactory.setPool(await meme.getAddress(), await paired.getAddress(), false, await pair.getAddress());

  const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
  const weekly = await Receiver.deploy();
  const monthly = await Receiver.deploy();
  const protocolVault = await Receiver.deploy();
  const router = await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(owner.address, await weekly.getAddress(), await monthly.getAddress(), 3600);
  await router.setProtocolRevenueVault(await protocolVault.getAddress());

  const locker = await (await ethers.getContractFactory("PermanentLpLocker")).deploy(owner.address);
  await locker.configureRevenue(await router.getAddress(), await topazFactory.getAddress());
  await router.setAuthorizedLpLocker(await locker.getAddress(), true);

  await meme.approve(await pair.getAddress(), ethers.MaxUint256);
  await paired.approve(await pair.getAddress(), ethers.MaxUint256);
  const memeIs0 = (await pair.token0()).toLowerCase() === (await meme.getAddress()).toLowerCase();
  await pair.seed(memeIs0 ? RESERVE_MEME : RESERVE_PAIRED, memeIs0 ? RESERVE_PAIRED : RESERVE_MEME);
  const lp = 10n * E18;
  await pair.mint(await locker.getAddress(), lp);
  const campaign = stranger.address;
  await locker.registerGraduatedPool(campaign, creator.address, recipient.address, await pair.getAddress(), await meme.getAddress(), await paired.getAddress(), lp);

  for (const s of [attacker]) {
    await meme.transfer(s.address, 100_000n * E18);
    await paired.transfer(s.address, 1_000n * E18);
  }

  async function fundFees(memeFee: bigint, pairedFee: bigint) {
    await pair.fundFees(await locker.getAddress(), memeIs0 ? memeFee : pairedFee, memeIs0 ? pairedFee : memeFee);
  }
  async function reserves() {
    const [r0, r1] = await pair.getReserves();
    return memeIs0 ? { meme: r0, paired: r1 } : { meme: r1, paired: r0 };
  }
  // price of MEME in paired, 1e18 fixed point
  async function price() {
    const r = await reserves();
    return (r.paired * E18) / r.meme;
  }
  async function swapIn(signer: any, tokenIn: any, amountIn: bigint) {
    const out = await pair.getAmountOut(amountIn, await tokenIn.getAddress());
    await tokenIn.connect(signer).transfer(await pair.getAddress(), amountIn);
    const inIs0 = (await pair.token0()).toLowerCase() === (await tokenIn.getAddress()).toLowerCase();
    await pair.connect(signer).swap(inIs0 ? 0n : out, inIs0 ? out : 0n, signer.address, "0x");
    return out;
  }
  return { owner, creator, recipient, attacker, meme, paired, pair, locker, router, protocolVault, fundFees, reserves, price, swapIn, memeIs0 };
}

describe("evmgen fees: PermanentLpLocker native-only harvest (E9, Topaz V2)", function () {
  it("sells a small MEME fee in full and splits paired + proceeds exactly 80/20", async function () {
    const f = await setup();
    const memeFee = 100n * E18;
    const pairedFee = 3n * E18;
    await f.fundFees(memeFee, pairedFee);
    const expectedOut = await f.pair.getAmountOut(memeFee, await f.meme.getAddress());
    await f.locker.harvest(await f.pair.getAddress());
    const total = pairedFee + expectedOut;
    const creatorShare = (total * 8000n) / 10000n;
    expect(await f.paired.balanceOf(f.recipient.address)).to.equal(creatorShare);
    expect(await f.paired.balanceOf(await f.protocolVault.getAddress())).to.equal(total - creatorShare);
    expect(await f.meme.balanceOf(f.recipient.address)).to.equal(0n);
    expect(await f.meme.balanceOf(await f.protocolVault.getAddress())).to.equal(0n);
    expect(await f.locker.carriedMeme(await f.pair.getAddress())).to.equal(0n);
    expect(await f.meme.balanceOf(await f.locker.getAddress())).to.equal(0n);
    expect(await f.paired.balanceOf(await f.locker.getAddress())).to.equal(0n);
    expect(await f.locker.cumulativeCreatorPaid(await f.pair.getAddress(), await f.paired.getAddress())).to.equal(creatorShare);
    expect(await f.locker.cumulativeProtocolRouted(await f.pair.getAddress(), await f.paired.getAddress())).to.equal(total - creatorShare);
  });

  it("bounds one harvest to 0.25% of the MEME reserve (<= 0.5% price move) and carries the rest to the next harvests", async function () {
    const f = await setup();
    const memeFee = 10_000n * E18; // 1% of the reserve
    await f.fundFees(memeFee, 0n);
    const p0 = await f.price();
    const r0 = await f.reserves();
    await f.locker.harvest(await f.pair.getAddress());
    const cap = (r0.meme * 50n) / 20000n;
    expect(await f.locker.carriedMeme(await f.pair.getAddress())).to.equal(memeFee - cap);
    const p1 = await f.price();
    expect(((p0 - p1) * 10000n) / p0).to.be.lte(50n);
    let harvests = 1;
    while ((await f.locker.carriedMeme(await f.pair.getAddress())) > 0n) {
      const pb = await f.price();
      await f.locker.harvest(await f.pair.getAddress());
      const pa = await f.price();
      expect(((pb - pa) * 10000n) / pb).to.be.lte(50n);
      harvests++;
      expect(harvests).to.be.lte(6);
    }
    expect(harvests).to.equal(4);
    // Everything the locker received went out as paired only; it holds no MEME and no paired afterwards.
    expect(await f.meme.balanceOf(await f.locker.getAddress())).to.equal(0n);
    expect(await f.paired.balanceOf(await f.locker.getAddress())).to.equal(0n);
    const paidCreator = await f.paired.balanceOf(f.recipient.address);
    const paidProtocol = await f.paired.balanceOf(await f.protocolVault.getAddress());
    const r1 = await f.reserves();
    expect(paidCreator + paidProtocol).to.equal(r0.paired - r1.paired); // conservation: proceeds == what the pair paid
    expect(r1.meme - r0.meme).to.equal(memeFee);
  });

  it("sells regardless of the pair's TWAP (no TWAP guard in the locker; the reserve bound carries the sandwich argument)", async function () {
    const f = await setup();
    await f.fundFees(100n * E18, 2n * E18);
    const r = await f.reserves();
    const tw = { meme: (r.meme * 100n) / 103n, paired: r.paired };
    await f.pair.setTwapReserves(f.memeIs0 ? tw.meme : tw.paired, f.memeIs0 ? tw.paired : tw.meme);
    await f.locker.harvest(await f.pair.getAddress());
    expect(await f.locker.carriedMeme(await f.pair.getAddress())).to.equal(0n);
  });

  it("never reverts the harvest when the sale itself fails: MEME is carried, paired is split", async function () {
    const f = await setup();
    await f.fundFees(100n * E18, 1n * E18);
    await f.pair.setSwapDisabled(true);
    await expect(f.locker.harvest(await f.pair.getAddress())).to.emit(f.locker, "MemeFeesSold").withArgs(await f.pair.getAddress(), await f.meme.getAddress(), 0n, 0n, 100n * E18);
    expect(await f.meme.balanceOf(await f.locker.getAddress())).to.equal(100n * E18);
    expect(await f.paired.balanceOf(f.recipient.address)).to.equal((1n * E18 * 8000n) / 10000n);
    await f.pair.setSwapDisabled(false);
    await f.locker.harvest(await f.pair.getAddress());
    expect(await f.meme.balanceOf(await f.locker.getAddress())).to.equal(0n);
  });

  it("a quote-bound pool pays creator and protocol in the quote token only (protocol via routeLpToken)", async function () {
    const f = await setup({ quote: true });
    await f.fundFees(500n * E18, 7n * E18);
    const out = await f.pair.getAmountOut(500n * E18, await f.meme.getAddress());
    await f.locker.harvest(await f.pair.getAddress());
    const total = 7n * E18 + out;
    expect(await f.paired.balanceOf(f.recipient.address)).to.equal((total * 8000n) / 10000n);
    expect(await f.paired.balanceOf(await f.protocolVault.getAddress())).to.equal(total - (total * 8000n) / 10000n);
    expect(await f.meme.balanceOf(f.recipient.address)).to.equal(0n);
  });

  it("sellMemeForPaired is callable by the locker only", async function () {
    const f = await setup();
    await expect(f.locker.sellMemeForPaired(await f.pair.getAddress(), await f.meme.getAddress(), 1n)).to.be.revertedWithCustomError(f.locker, "OnlySelf");
  });

  it("a sandwich around a permissionless harvest loses the attacker money at every size", async function () {
    for (const attackMeme of [1_000n * E18, 10_000n * E18, 50_000n * E18, 100_000n * E18]) {
      const f = await setup();
      await f.fundFees(2_500n * E18, 0n); // exactly the one-harvest cap
      const pairedBefore = await f.paired.balanceOf(f.attacker.address);
      const memeBefore = await f.meme.balanceOf(f.attacker.address);
      await f.swapIn(f.attacker, f.meme, attackMeme); // front-run: push MEME down
      await f.locker.harvest(await f.pair.getAddress());
      // back-run: buy back at least the MEME sold
      let spend = 0n;
      let lo = 0n;
      let hi = await f.paired.balanceOf(f.attacker.address);
      const memeIn = await f.meme.getAddress();
      const pairedAddr = await f.paired.getAddress();
      memeIn;
      while (lo < hi) {
        const mid = (lo + hi) / 2n;
        if ((await f.pair.getAmountOut(mid, pairedAddr)) >= attackMeme) hi = mid;
        else lo = mid + 1n;
      }
      spend = lo;
      await f.swapIn(f.attacker, f.paired, spend);
      const memeAfter = await f.meme.balanceOf(f.attacker.address);
      const pairedAfter = await f.paired.balanceOf(f.attacker.address);
      expect(memeAfter).to.be.gte(memeBefore);
      expect(pairedAfter).to.be.lt(pairedBefore, `attack ${attackMeme / E18} MEME`);
    }
  });

  it("conservation over a random sequence of fees and harvests", async function () {
    const f = await setup();
    let seed = 12345n;
    let memeIn = 0n;
    let pairedIn = 0n;
    const r0 = await f.reserves();
    for (let i = 0; i < 12; i++) {
      seed = (seed * 1103515245n + 12345n) % 2n ** 31n;
      const m = (seed % 5000n) * E18;
      const p = (seed % 7n) * E18;
      await f.fundFees(m, p);
      memeIn += m;
      pairedIn += p;
      await f.locker.harvest(await f.pair.getAddress());
      const carried = await f.locker.carriedMeme(await f.pair.getAddress());
      expect(await f.meme.balanceOf(await f.locker.getAddress())).to.equal(carried);
      expect(await f.paired.balanceOf(await f.locker.getAddress())).to.equal(0n);
    }
    const r1 = await f.reserves();
    const carried = await f.locker.carriedMeme(await f.pair.getAddress());
    expect(r1.meme - r0.meme + carried).to.equal(memeIn);
    const paid = (await f.paired.balanceOf(f.recipient.address)) + (await f.paired.balanceOf(await f.protocolVault.getAddress()));
    expect(paid).to.equal(pairedIn + (r0.paired - r1.paired));
  });

  it("keeps the 30 bps pool fee requirement (founder Q4 open)", async function () {
    expect(await (await (await ethers.getContractFactory("PermanentLpLocker")).deploy((await ethers.getSigners())[0].address)).REQUIRED_POOL_FEE_BPS()).to.equal(30n);
  });
});
