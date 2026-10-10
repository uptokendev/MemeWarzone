// t31: MuchfiV3NativeGraduationAdapter (+ MuchfiV3PoolRepair) against the real MuchFi bytecode on a Chikyū fork.
//
//   npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/MuchfiGraduationAdapter.fork.spec.ts
//
// The variant is RobinhoodV3NativeGraduationAdapterV2 + RobinhoodV3PoolRepair with muchfiV3SwapCallback instead of
// uniswapV3SwapCallback, a uint32 slot0.feeProtocol, POOL_FEE 10000 / TICK_SPACING 200 and the full-range bounds for
// spacing 200 (ticks ±887200, sqrt bounds TickMath.getSqrtRatioAtTick(±887200)). Same harness as
// test/evmgen-rh-graduation.fork.spec.ts (MockEvmGenRhFactory + MockEvmGenRhCampaign owning a real LaunchToken),
// but on the real MuchFi factory/NPM/WDOGE with MuchfiV3PositionLocker where the original pairs with
// PermanentV3PositionLocker. Everything runs on the in-process fork with hardhat's local funded accounts; nothing is
// sent to Chikyū. Under any other config the suite skips (skipUnlessChikyuFork).
import { expect } from "chai";
import { ethers } from "hardhat";
import type { Contract, Signer, TransactionReceipt } from "ethers";
import {
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
  MUCHFI,
  MUCHFI_FACTORY_ABI,
  MUCHFI_FEE,
  MUCHFI_MAX_TICK,
  MUCHFI_MIN_TICK,
  MUCHFI_NPM_ABI,
  MUCHFI_POOL_ABI,
  MUCHFI_TICK_SPACING,
  WDOGE_ABI,
  skipUnlessChikyuFork,
} from "./helpers/muchfiFork";

const Q192 = 1n << 192n;
const WAD = 10n ** 18n;
const SUPPLY = 10n ** 27n;
const RESERVE = 2n * 10n ** 25n;
const MAX_MEME_DUST = 10n ** 12n;

/**
 * @uniswap/v3-core 1.0.1 TickMath.getSqrtRatioAtTick(±887200), computed by compiling
 * tools/robinhood-testnet-infra/node_modules/@uniswap/v3-core/contracts/libraries/TickMath.sol with solc 0.7.6 and
 * calling it. The variant's MIN/MAX_FULL_RANGE_SQRT must equal these.
 */
const V3CORE_SQRT_AT_MINUS_887200 = 4310618292n;
const V3CORE_SQRT_AT_PLUS_887200 = 1456195216270955103206513029158776779468408838535n;
/** The original's spacing-60 bounds (RobinhoodV3PoolRepair.sol:83-84), = getSqrtRatioAtTick(±887220). */
const RH_MIN_FULL_RANGE_SQRT = 4306310044n;
const RH_MAX_FULL_RANGE_SQRT = 1457652066949847389969617340386294118487833376468n;

/** Line-for-line BigInt port of @uniswap/v3-core TickMath.getSqrtRatioAtTick (cross-checked below). */
function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = BigInt(Math.abs(tick));
  if (absTick > 887272n) throw new Error("T");
  const M: [bigint, bigint][] = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  let ratio = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, mul] of M) if ((absTick & bit) !== 0n) ratio = (ratio * mul) >> 128n;
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

const NPM_ABI = [
  ...MUCHFI_NPM_ABI,
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
] as const;
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function tradingEnabled() view returns (bool)",
] as const;

function isqrt(v: bigint): bigint {
  if (v < 2n) return v;
  let x = 1n << BigInt((v.toString(2).length >> 1) + 1); // >= sqrt(v)
  for (;;) {
    const y = (x + v / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
/** Same as MuchfiV3PriceMath.sqrtFromPrice (512-bit mulDiv floor, then floor sqrt). */
function sqrtFromPrice(pWad: bigint, memeIs0: boolean): bigint {
  return isqrt(memeIs0 ? (pWad * Q192) / WAD : (WAD * Q192) / pWad);
}
function tickOf(sqrt: bigint): number {
  const r = Number(sqrt) / 2 ** 96;
  return Math.floor(Math.log(r * r) / Math.log(1.0001));
}

/** The C5 numbers for a campaign that graduates after `soldWhole` tokens (k = 850, b = 1e9; as the RH fork spec). */
function curve(soldWhole: bigint) {
  const b = 1_000_000_000n;
  const k = 850n;
  const P = b + k * soldWhole;
  const R = soldWhole * b + (k * soldWhole * soldWhole) / 2n;
  const protocol = (R * 220n) / 10_000n;
  const creator = (R * 1980n) / 10_000n;
  const poolNative = R - protocol - creator;
  const T = (poolNative * WAD) / P;
  const budget = SUPPLY - RESERVE - soldWhole * WAD;
  return { P, R, poolNative, T, budget };
}

type Ctx = { campaign: Contract; cAddr: string; meme: Contract; memeAddr: string };

describe("MuchfiV3NativeGraduationAdapter on a Chikyū fork (t31)", function () {
  let deployer: Signer;
  let griefOwner: Signer;
  let stranger: Signer;
  let deployerAddress: string;
  let v3: Contract;
  let npm: Contract;
  let wdoge: Contract;
  let adapter: Contract;
  let locker: Contract;
  let harnessFactory: Contract;
  let mathHarness: Contract;

  before(async function () {
    skipUnlessChikyuFork(this);
    [deployer, griefOwner, stranger] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    v3 = new ethers.Contract(MUCHFI.FACTORY, MUCHFI_FACTORY_ABI, deployer);
    npm = new ethers.Contract(MUCHFI.NPM, NPM_ABI, deployer);
    wdoge = new ethers.Contract(MUCHFI.WDOGE, WDOGE_ABI, deployer);

    const receiver = await (await ethers.getContractFactory("AcceptingReceiver")).deploy();
    locker = (await (await ethers.getContractFactory("MuchfiV3PositionLocker")).deploy(deployerAddress)) as unknown as Contract;
    harnessFactory = (await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(
      await locker.getAddress(),
    )) as unknown as Contract;
    adapter = (await (await ethers.getContractFactory("MuchfiV3NativeGraduationAdapter")).deploy(
      MUCHFI.FACTORY,
      MUCHFI.NPM,
      MUCHFI.WDOGE,
      deployerAddress,
    )) as unknown as Contract;
    await (await locker.configureRevenue(await receiver.getAddress(), await adapter.getAddress())).wait();
    await (await adapter.setCampaignFactoryOnce(await harnessFactory.getAddress())).wait();
    mathHarness = (await (await ethers.getContractFactory("MuchfiForkPriceMathHarness")).deploy()) as unknown as Contract;
  });

  /** A harness campaign whose LaunchToken sorts below (`memeIs0`) or above WDOGE. */
  async function newCampaign(memeIs0: boolean): Promise<Ctx> {
    const campaign = (await (await ethers.getContractFactory("MockEvmGenRhCampaign")).deploy()) as unknown as Contract;
    const cAddr = await campaign.getAddress();
    const tokenFactory = await ethers.getContractFactory("LaunchToken");
    const initCode =
      tokenFactory.bytecode +
      ethers.AbiCoder.defaultAbiCoder().encode(["string", "string", "uint256", "address"], ["Meme", "MEME", SUPPLY, cAddr]).slice(2);
    const codeHash = ethers.keccak256(initCode);
    const pairedN = BigInt(MUCHFI.WDOGE);
    for (let i = 0; i < 100_000; i++) {
      const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const predicted = ethers.getCreate2Address(cAddr, salt, codeHash);
      if ((BigInt(predicted) < pairedN) === memeIs0) {
        await (await campaign.init(salt, SUPPLY)).wait();
        expect((await campaign.token()).toLowerCase()).to.equal(predicted.toLowerCase());
        await (await harnessFactory.setCampaign(cAddr, true)).wait();
        const meme = new ethers.Contract(predicted, ERC20_ABI, deployer);
        return { campaign, cAddr, meme, memeAddr: predicted };
      }
    }
    throw new Error("no salt");
  }

  function sorted(memeAddr: string): [string, string] {
    return BigInt(memeAddr) < BigInt(MUCHFI.WDOGE) ? [memeAddr, MUCHFI.WDOGE] : [MUCHFI.WDOGE, memeAddr];
  }

  /** Someone pre-creates the canonical MEME/WDOGE 1% pool at `pricePairedPerMemeWad` before graduation. */
  async function preCreate(memeAddr: string, pricePairedPerMemeWad: bigint): Promise<Contract> {
    const [t0, t1] = sorted(memeAddr);
    const memeIs0 = t0 === memeAddr;
    await (await npm.createAndInitializePoolIfNecessary(t0, t1, MUCHFI_FEE, sqrtFromPrice(pricePairedPerMemeWad, memeIs0))).wait();
    const poolAddr = await v3.getPool(t0, t1, MUCHFI_FEE);
    expect(poolAddr).to.not.equal(ethers.ZeroAddress);
    return new ethers.Contract(poolAddr, MUCHFI_POOL_ABI, deployer);
  }

  /** WDOGE-only bids (MEME bought at MEME prices between priceA and priceB) minted through the real MuchFi NPM. */
  async function wdogeBids(memeAddr: string, priceA: bigint, priceB: bigint, count: number, wdogePerRange: bigint) {
    const [t0, t1] = sorted(memeAddr);
    const memeIs0 = t0 === memeAddr;
    const ta = tickOf(sqrtFromPrice(priceA, memeIs0));
    const tb = tickOf(sqrtFromPrice(priceB, memeIs0));
    const lo = Math.min(ta, tb);
    const hi = Math.max(ta, tb);
    const first = (Math.floor(lo / MUCHFI_TICK_SPACING) + 2) * MUCHFI_TICK_SPACING;
    const width = Math.floor((hi - first) / count / MUCHFI_TICK_SPACING) * MUCHFI_TICK_SPACING;
    expect(width).to.be.greaterThan(0);
    const owner = griefOwner;
    const g = wdoge.connect(owner) as Contract;
    await (await g.deposit({ value: wdogePerRange * BigInt(count) })).wait();
    await (await g.approve(MUCHFI.NPM, ethers.MaxUint256)).wait();
    const latest = await ethers.provider.getBlock("latest");
    for (let i = 0; i < count; i++) {
      const lower = first + i * width;
      await (
        await (npm.connect(owner) as Contract).mint({
          token0: t0,
          token1: t1,
          fee: MUCHFI_FEE,
          tickLower: lower,
          tickUpper: lower + width,
          amount0Desired: memeIs0 ? 0n : wdogePerRange,
          amount1Desired: memeIs0 ? wdogePerRange : 0n,
          amount0Min: 0,
          amount1Min: 0,
          recipient: await owner.getAddress(),
          deadline: Number(latest!.timestamp) + 3600,
        })
      ).wait();
    }
  }

  /** Graduate through the harness campaign and check every C5/C7 invariant that holds for all cases. */
  async function graduateAndCheck(ctx: Ctx, c: ReturnType<typeof curve>, opts: { expectRepair?: boolean } = {}) {
    const adapterAddr = await adapter.getAddress();
    const memeIs0 = BigInt(ctx.memeAddr) < BigInt(MUCHFI.WDOGE);
    const stepSold: bigint = await ctx.campaign.repairMemeSold();
    const stepNative: bigint = await ctx.campaign.repairNativeProceeds();
    await (await deployer.sendTransaction({ to: ctx.cAddr, value: c.poolNative })).wait();

    const poolAddrBefore = await v3.getPool(ctx.memeAddr, MUCHFI.WDOGE, MUCHFI_FEE);
    const poolWdogeBefore = poolAddrBefore === ethers.ZeroAddress ? 0n : await wdoge.balanceOf(poolAddrBefore);
    const poolMemeBefore = poolAddrBefore === ethers.ZeroAddress ? 0n : await ctx.meme.balanceOf(poolAddrBefore);
    const campaignMemeBefore = await ctx.meme.balanceOf(ctx.cAddr);

    const receipt = (await (
      await ctx.campaign.graduate(adapterAddr, ethers.ZeroAddress, c.T, c.budget, c.P, c.poolNative)
    ).wait()) as TransactionReceipt;
    const res = await ctx.campaign.lastResult();
    const memeBack: bigint = await ctx.campaign.lastMemeBack();
    const memeUsed: bigint = await ctx.campaign.lastMemeUsed();
    const nativeBack: bigint = await ctx.campaign.lastNativeBack();
    const memeMax = c.budget - stepSold;

    // No residual native / WDOGE / MEME (or allowance) on the adapter.
    expect(await ethers.provider.getBalance(adapterAddr)).to.equal(0n);
    expect(await wdoge.balanceOf(adapterAddr)).to.equal(0n);
    expect(await ctx.meme.balanceOf(adapterAddr)).to.equal(0n);
    expect(await ctx.meme.allowance(ctx.cAddr, adapterAddr)).to.equal(0n);

    // MEME conservation: used + returned == pulled budget; all used MEME sits in the pool.
    expect(memeUsed + memeBack).to.equal(memeMax);
    expect(campaignMemeBefore - (await ctx.meme.balanceOf(ctx.cAddr))).to.equal(memeUsed);
    expect(res.memeUsed).to.equal(memeUsed);
    expect(res.pool).to.equal(await v3.getPool(ctx.memeAddr, MUCHFI.WDOGE, MUCHFI_FEE));
    expect((await ctx.meme.balanceOf(res.pool)) - poolMemeBefore).to.equal(memeUsed);
    expect(poolMemeBefore).to.equal(stepSold); // only earlier repair steps ever put MEME in

    // Native conservation into the pool.
    const nativeIn = c.poolNative + stepNative;
    expect((await wdoge.balanceOf(res.pool)) - poolWdogeBefore).to.equal(nativeIn - nativeBack);

    // The 1% full-range (±887200) position NFT ends in the MuchFi locker, recorded for this pool.
    const pool = new ethers.Contract(res.pool, MUCHFI_POOL_ABI, deployer);
    expect(await pool.fee()).to.equal(BigInt(MUCHFI_FEE));
    expect(await pool.tickSpacing()).to.equal(BigInt(MUCHFI_TICK_SPACING));
    expect(await npm.ownerOf(res.positionId)).to.equal(await locker.getAddress());
    expect(await locker.pendingPositionByPool(res.pool)).to.equal(res.positionId);
    const pos = await npm.positions(res.positionId);
    expect(pos.fee).to.equal(BigInt(MUCHFI_FEE));
    expect(pos.tickLower).to.equal(BigInt(MUCHFI_MIN_TICK));
    expect(pos.tickUpper).to.equal(BigInt(MUCHFI_MAX_TICK));
    expect(pos.liquidity).to.equal(res.liquidity);
    expect(res.liquidity).to.be.greaterThan(0n);

    // The pool opens exactly at the curve price (sqrt of P).
    const target = sqrtFromPrice(c.P, memeIs0);
    const slot = await pool.slot0();
    expect(slot.sqrtPriceX96).to.equal(target);
    // C5 1.9: nativeBack <= 1 bp unless the budget was used up.
    if (memeBack > MAX_MEME_DUST) expect(nativeBack * 10_000n).to.be.lte(nativeIn);
    // The repair only ever sells at >= 0.99 * P (before MuchFi's 1% fee: >= P).
    if (res.repairMemeSold > 0n) expect(res.repairProceeds * 100n * WAD).to.be.gte(99n * c.P * res.repairMemeSold);
    if (opts.expectRepair !== undefined) expect(res.repaired).to.equal(opts.expectRepair);
    // The in-graduation repair swaps (each one a completed pool.swap, whose callback the pool always invokes).
    const repairs = receipt.logs
      .filter((l) => l.address.toLowerCase() === adapterAddr.toLowerCase())
      .map((l) => adapter.interface.parseLog({ topics: [...l.topics], data: l.data }))
      .filter((e) => e !== null && e.name === "PoolRepaired")
      .map((e) => e!.args);
    return { res, memeBack, memeUsed, nativeBack, memeIs0, pool, repairs };
  }

  describe("surface", function () {
    it("keeps the factory/keeper surface: v3Factory, WETH, POOL_FEE 10000, TICK_SPACING 200, liquidityKind 2, feeTier, getPool", async function () {
      expect(await adapter.v3Factory()).to.equal(MUCHFI.FACTORY);
      expect(await adapter.positionManager()).to.equal(MUCHFI.NPM);
      expect(await adapter.WETH()).to.equal(MUCHFI.WDOGE);
      expect(await adapter.POOL_FEE()).to.equal(10000n);
      expect(await adapter.TICK_SPACING()).to.equal(200n);
      expect(await adapter.feeTier()).to.equal(10000n);
      expect(await adapter.liquidityKind()).to.equal(2n);
      expect(await adapter.LIQUIDITY_KIND_V3_NFT()).to.equal(2n);
      expect(await adapter.MAX_MEME_DUST()).to.equal(MAX_MEME_DUST);
      expect(await adapter.admin()).to.equal(deployerAddress);
      expect(await adapter.poolFactory()).to.equal(await adapter.getAddress());
      expect(await adapter.campaignFactory()).to.equal(await harnessFactory.getAddress());
      expect(await adapter.permanentPositionLocker()).to.equal(await locker.getAddress());
      expect(await v3.feeAmountTickSpacing(await adapter.POOL_FEE())).to.equal(await adapter.TICK_SPACING());
      // The locker took its integration config from the adapter: MuchFi factory/NPM/WDOGE at 1%.
      expect(await locker.v3Factory()).to.equal(MUCHFI.FACTORY);
      expect(await locker.positionManager()).to.equal(MUCHFI.NPM);
      expect(await locker.wrappedNative()).to.equal(MUCHFI.WDOGE);
      expect(await locker.configuredFeeTier()).to.equal(10000n);
      const pool = await preCreate((await newCampaign(true)).memeAddr, 137_000_000_000n);
      const [t0, t1] = [await pool.token0(), await pool.token1()];
      expect(await adapter["getPool(address,address,bool)"](t0, t1, false)).to.equal(await pool.getAddress());
      await expect(adapter["getPool(address,address,bool)"](t0, t1, true)).to.be.revertedWithCustomError(adapter, "InvalidPair");
    });

    it("the original adapter cannot even be deployed on MuchFi (0.30% is not enabled there); the variant's fee check is the same", async function () {
      const Original = await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2");
      await expect(Original.deploy(MUCHFI.FACTORY, MUCHFI.NPM, MUCHFI.WDOGE, deployerAddress)).to.be.revertedWithCustomError(
        Original,
        "InvalidFeeTier",
      );
      const Variant = await ethers.getContractFactory("MuchfiV3NativeGraduationAdapter");
      const spacing60 = await (await ethers.getContractFactory("MockEvmGenRhSpacingFactory")).deploy(60);
      await expect(Variant.deploy(await spacing60.getAddress(), MUCHFI.NPM, MUCHFI.WDOGE, deployerAddress)).to.be.revertedWithCustomError(
        Variant,
        "InvalidFeeTier",
      );
      await expect(Variant.deploy(ethers.ZeroAddress, MUCHFI.NPM, MUCHFI.WDOGE, deployerAddress)).to.be.revertedWithCustomError(
        Variant,
        "ZeroAddress",
      );
      await expect(Variant.deploy(MUCHFI.FACTORY, await stranger.getAddress(), MUCHFI.WDOGE, deployerAddress)).to.be.revertedWithCustomError(
        Variant,
        "ContractCodeMissing",
      );
    });

    it("the ABI is the original's with only the callback renamed (events and errors identical)", async function () {
      const variantIface = (await ethers.getContractFactory("MuchfiV3NativeGraduationAdapter")).interface;
      const originalIface = (await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2")).interface;
      const sigs = (iface: typeof variantIface, type: "function" | "event" | "error") =>
        iface.fragments
          .filter((f) => f.type === type)
          .map((f) => f.format("full"))
          .sort();
      const renamed = sigs(originalIface, "function").map((s) =>
        s.replace("function uniswapV3SwapCallback(", "function muchfiV3SwapCallback("),
      );
      expect(sigs(variantIface, "function")).to.deep.equal(renamed.sort());
      expect(sigs(variantIface, "event")).to.deep.equal(sigs(originalIface, "event"));
      expect(sigs(variantIface, "error")).to.deep.equal(sigs(originalIface, "error"));
      expect(variantIface.getFunction("uniswapV3SwapCallback")).to.equal(null);
    });

    it("muchfiV3SwapCallback refuses every caller outside the adapter's own swap", async function () {
      await expect(adapter.muchfiV3SwapCallback(1n, 0n, "0x")).to.be.revertedWithCustomError(adapter, "UnauthorizedCallback");
      await expect((adapter.connect(stranger) as Contract).muchfiV3SwapCallback(0n, 1n, "0x")).to.be.revertedWithCustomError(
        adapter,
        "UnauthorizedCallback",
      );
    });

    it("graduate and repairStep refuse a caller the factory does not know", async function () {
      const ctx = await newCampaign(true);
      await (await harnessFactory.setCampaign(ctx.cAddr, false)).wait();
      const c = curve(160_000_000n);
      await (await deployer.sendTransaction({ to: ctx.cAddr, value: c.poolNative })).wait();
      await expect(ctx.campaign.graduate(await adapter.getAddress(), ethers.ZeroAddress, c.T, c.budget, c.P, c.poolNative)).to.be.revertedWithCustomError(
        adapter,
        "UnauthorizedCampaign",
      );
      await expect(ctx.campaign.repairPool(await adapter.getAddress(), ethers.ZeroAddress, c.T, c.budget, c.P, 0n)).to.be.revertedWithCustomError(
        adapter,
        "UnauthorizedCampaign",
      );
    });
  });

  describe("full-range bounds for spacing 200", function () {
    it("MIN/MAX_FULL_RANGE_SQRT == @uniswap/v3-core TickMath.getSqrtRatioAtTick(∓887200), not the original's ±887220", async function () {
      // The port reproduces v3-core's documented values at MIN/MAX_TICK and the original's spacing-60 constants.
      expect(getSqrtRatioAtTick(-887272)).to.equal(MIN_SQRT_RATIO);
      expect(getSqrtRatioAtTick(887272)).to.equal(MAX_SQRT_RATIO);
      expect(getSqrtRatioAtTick(-887220)).to.equal(RH_MIN_FULL_RANGE_SQRT);
      expect(getSqrtRatioAtTick(887220)).to.equal(RH_MAX_FULL_RANGE_SQRT);
      expect(getSqrtRatioAtTick(-887200)).to.equal(V3CORE_SQRT_AT_MINUS_887200);
      expect(getSqrtRatioAtTick(887200)).to.equal(V3CORE_SQRT_AT_PLUS_887200);
      // ±887200 is the widest multiple of 200 inside ±887272.
      expect(MUCHFI_MAX_TICK % MUCHFI_TICK_SPACING).to.equal(0);
      expect(MUCHFI_MAX_TICK + MUCHFI_TICK_SPACING).to.be.greaterThan(887272);
      expect(MUCHFI_MIN_TICK).to.equal(-MUCHFI_MAX_TICK);

      expect(await mathHarness.minFullRangeSqrt()).to.equal(V3CORE_SQRT_AT_MINUS_887200);
      expect(await mathHarness.maxFullRangeSqrt()).to.equal(V3CORE_SQRT_AT_PLUS_887200);
    });

    it("MuchFi's own TickMath agrees: a pool initialized at the bound sits exactly on tick ∓887200, one below it on the tick under", async function () {
      const Token = await ethers.getContractFactory("MockERC20");
      const tokens: string[] = [];
      for (let i = 0; i < 4; i++) {
        const t = await Token.deploy(`Bound ${i}`, `B${i}`, 10n ** 24n, deployerAddress);
        tokens.push(await t.getAddress());
      }
      const pairs: [string, string][] = [
        [tokens[0], tokens[1]],
        [tokens[0], tokens[2]],
        [tokens[0], tokens[3]],
        [tokens[1], tokens[2]],
      ];
      const cases: [bigint, number][] = [
        [V3CORE_SQRT_AT_MINUS_887200, -887200],
        [V3CORE_SQRT_AT_MINUS_887200 - 1n, -887201],
        [V3CORE_SQRT_AT_PLUS_887200, 887200],
        [V3CORE_SQRT_AT_PLUS_887200 - 1n, 887199],
      ];
      for (let i = 0; i < cases.length; i++) {
        const [a, b] = pairs[i];
        const [t0, t1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
        await (await npm.createAndInitializePoolIfNecessary(t0, t1, MUCHFI_FEE, cases[i][0])).wait();
        const pool = new ethers.Contract(await v3.getPool(t0, t1, MUCHFI_FEE), MUCHFI_POOL_ABI, deployer);
        const slot = await pool.slot0();
        expect(slot.sqrtPriceX96).to.equal(cases[i][0]);
        // getTickAtSqrtRatio(s) is the greatest tick whose sqrt ratio <= s, so tick(s) == t and tick(s - 1) == t - 1
        // means getSqrtRatioAtTick(t) == s exactly.
        expect(slot.tick, `sqrt ${cases[i][0]}`).to.equal(BigInt(cases[i][1]));
      }
    });

    it("the target range check uses the new bounds: sqrt <= getSqrtRatioAtTick(-887200) is refused, one above is accepted", async function () {
      const MIN = V3CORE_SQRT_AT_MINUS_887200;
      // memeIs0: ratioX192 = pairedRaw * 2^192 / memeRaw; with memeRaw = 2^192 the sqrt is exactly isqrt(pairedRaw).
      await expect(mathHarness.sqrtFromRatio(MIN * MIN, Q192, true)).to.be.revertedWithCustomError(mathHarness, "TargetOutOfRange");
      expect(await mathHarness.sqrtFromRatio((MIN + 1n) * (MIN + 1n), Q192, true)).to.equal(MIN + 1n);
      // Between the original's bound and the new one: accepted by the original, refused here (it would sit below tick -887200).
      expect(RH_MIN_FULL_RANGE_SQRT + 1n).to.be.lessThan(MIN);
      await expect(
        mathHarness.sqrtFromRatio((RH_MIN_FULL_RANGE_SQRT + 1n) * (RH_MIN_FULL_RANGE_SQRT + 1n), Q192, true),
      ).to.be.revertedWithCustomError(mathHarness, "TargetOutOfRange");
      // The curve-price conversion is the original's math.
      for (const p of [1_000_000_000n, 137_000_000_000n, 10n ** 15n]) {
        for (const memeIs0 of [true, false]) expect(await mathHarness.sqrtFromPrice(p, memeIs0)).to.equal(sqrtFromPrice(p, memeIs0));
      }
    });
  });

  for (const memeIs0 of [true, false]) {
    const ord = memeIs0 ? "MEME<WDOGE" : "MEME>WDOGE";

    describe(`graduation ${ord}`, function () {
      it("no pool: creates the 1% MuchFi pool at the curve price, full range, NFT locked, nothing left on the adapter", async function () {
        const ctx = await newCampaign(memeIs0);
        const c = curve(160_000_000n);
        expect(await v3.getPool(ctx.memeAddr, MUCHFI.WDOGE, MUCHFI_FEE)).to.equal(ethers.ZeroAddress);
        const out = await graduateAndCheck(ctx, c, { expectRepair: false });
        expect(out.res.repairMemeSold).to.equal(0n);
        expect(out.res.repairProceeds).to.equal(0n);
        expect(out.nativeBack * 10_000n).to.be.lte(c.poolNative);
        expect(await ctx.meme.tradingEnabled()).to.equal(true);
      });

      for (const [name, mul, div] of [
        ["1/1000x", 1n, 1000n],
        ["1000x", 1000n, 1n],
      ] as const) {
        it(`empty pool pre-created at ${name} the curve price: the repair (muchfiV3SwapCallback) moves it to the target for free`, async function () {
          const ctx = await newCampaign(memeIs0);
          const c = curve(160_000_000n);
          const pool = await preCreate(ctx.memeAddr, (c.P * mul) / div);
          expect((await pool.slot0()).sqrtPriceX96).to.not.equal(sqrtFromPrice(c.P, memeIs0));
          const out = await graduateAndCheck(ctx, c);
          expect(out.res.pool).to.equal(await pool.getAddress());
          // Moved through zero liquidity: nothing sold, nothing bought, so not "repaired" in the C5 sense.
          expect(out.res.repairMemeSold).to.equal(0n);
          expect(out.res.repairProceeds).to.equal(0n);
          expect(out.res.repaired).to.equal(false);
          // One zero-cost swap through muchfiV3SwapCallback moved the price to the target.
          expect(out.repairs).to.have.length(1);
          // `memeSale` is the swap direction (MEME in when MEME is too expensive); through zero liquidity nothing moves.
          expect(out.repairs[0].memeSale).to.equal(mul > div);
          expect(out.repairs[0].inGraduation).to.equal(true);
          expect(out.repairs[0].sqrtPriceAfter).to.equal(sqrtFromPrice(c.P, memeIs0));
          expect(out.repairs[0].memeSold).to.equal(0n);
          expect(out.repairs[0].proceeds).to.equal(0n);
        });
      }

      it("pool pre-created at 1000x with WDOGE bids above P: spare MEME is sold through muchfiV3SwapCallback at >= 0.99 P, pool ends at P", async function () {
        const ctx = await newCampaign(memeIs0);
        const c = curve(160_000_000n);
        const pool = await preCreate(ctx.memeAddr, c.P * 1000n);
        await wdogeBids(ctx.memeAddr, c.P * 2n, c.P * 900n, 5, 2n * WAD);
        const poolWdoge = await wdoge.balanceOf(await pool.getAddress());
        const out = await graduateAndCheck(ctx, c, { expectRepair: true });
        expect(out.res.repairMemeSold).to.be.greaterThan(0n);
        expect(out.res.repairProceeds).to.be.greaterThan(0n);
        expect(out.res.donationFound).to.equal(poolWdoge);
        expect(out.res.repairProceeds).to.be.lessThanOrEqual(poolWdoge);
        // A MEME sale paid by the campaign inside muchfiV3SwapCallback, ending at the target.
        expect(out.repairs.length).to.be.greaterThan(0);
        expect(out.repairs[0].memeSale).to.equal(true);
        expect(out.repairs.reduce((a, r) => a + (r.memeSold as bigint), 0n)).to.equal(out.res.repairMemeSold);
        expect(out.repairs[out.repairs.length - 1].sqrtPriceAfter).to.equal(sqrtFromPrice(c.P, memeIs0));
      });

      it("chunked repairStep (uint32 slot0 read twice) then graduate: ledger consumed, pool ends at P", async function () {
        const ctx = await newCampaign(memeIs0);
        const c = curve(160_000_000n);
        const pool = await preCreate(ctx.memeAddr, c.P * 1000n);
        await wdogeBids(ctx.memeAddr, c.P * 2n, c.P * 900n, 5, 2n * WAD);
        const target = sqrtFromPrice(c.P, memeIs0);
        const sqrtC: bigint = (await pool.slot0()).sqrtPriceX96;
        // Stop halfway (in sqrt space) between the current price and the target.
        const limit = (sqrtC + target) / 2n;
        await (await ctx.campaign.repairPool(await adapter.getAddress(), ethers.ZeroAddress, c.T, c.budget, c.P, limit)).wait();
        const sold: bigint = await ctx.campaign.repairMemeSold();
        const proceeds: bigint = await ctx.campaign.repairNativeProceeds();
        expect(sold).to.be.greaterThan(0n);
        expect(proceeds).to.be.greaterThan(0n);
        expect(proceeds * 100n * WAD).to.be.gte(99n * c.P * sold);
        const ledger = await adapter.repairLedger(ctx.cAddr);
        expect(ledger.memeSold).to.equal(sold);
        expect(ledger.proceeds).to.equal(proceeds);
        expect(ledger.sqrtReached).to.equal(limit);
        expect((await pool.slot0()).sqrtPriceX96).to.equal(limit);
        expect(await ethers.provider.getBalance(await adapter.getAddress())).to.equal(0n);
        expect(await wdoge.balanceOf(await adapter.getAddress())).to.equal(0n);

        const out = await graduateAndCheck(ctx, c, { expectRepair: true });
        const after = await adapter.repairLedger(ctx.cAddr);
        expect(after.memeSold).to.equal(0n);
        expect(after.proceeds).to.equal(0n);
        expect(out.res.pool).to.equal(await pool.getAddress());
      });
    });
  }
});
