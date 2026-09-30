/**
 * Robinhood (4663) graduation adapters V2 on a fork of Robinhood mainnet, against the real Uniswap V3
 * factory, NonfungiblePositionManager, SwapRouter02, WETH9, Chainlink ETH/USD and a real Stock Token.
 * Spec: docs/evm-launch/spec/C7-robinhood-adapters.md section 7, C5-graduation.md sections 7 and 10.
 *
 *   npx hardhat --config hardhat.rh-fork.config.ts test test/evmgen-rh-graduation.fork.spec.ts
 *
 * Read-only against the live chain: the fork runs in-process; nothing is sent to 4663.
 * Skipped under the default config (no fork).
 */
import { expect } from "chai";
import { ethers, network } from "hardhat";

const RH = {
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  npm: "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3",
  swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  ethUsd: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
  // config/robinhood/mainnet-stock-routes.json
  spy: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  spyFeed: "0x319724394D3A0e3669269846abE664Cd621f9f6A",
  spyPool: "0xDDCBBa3666f578E3F09516f21Ff85BFee859AB5e",
};

const dbg = (m: string) => (process.env.RH_DEBUG ? console.log(`        [dbg ${new Date().toISOString().slice(11, 19)}] ${m}`) : undefined);
const FORKED = network.name === "hardhat" && Boolean((network.config as any).forking?.url) && network.config.chainId === 4663;
const d = FORKED ? describe : describe.skip;

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const WAD = 10n ** 18n;
const SUPPLY = 10n ** 27n;
const RESERVE = 2n * 10n ** 25n;
const MAX_MEME_DUST = 10n ** 12n;

const V3_FACTORY_ABI = [
  "function getPool(address,address,uint24) view returns (address)",
  "function createPool(address,address,uint24) returns (address)",
];
const POOL_ABI = [
  "function initialize(uint160)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
];
const NPM_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128,uint128)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];
const WETH_ABI = [...ERC20_ABI, "function deposit() payable"];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];

function isqrt(v: bigint): bigint {
  if (v < 2n) return v;
  let x = 1n << BigInt((v.toString(2).length >> 1) + 1); // >= sqrt(v)
  for (;;) {
    const y = (x + v / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}
/** Same as RobinhoodV3PriceMath.sqrtFromPrice. */
function sqrtFromPrice(pWad: bigint, memeIs0: boolean): bigint {
  return isqrt(memeIs0 ? (pWad * Q192) / WAD : (WAD * Q192) / pWad);
}
function priceFromSqrt(s: bigint, memeIs0: boolean): bigint {
  return memeIs0 ? (s * s * WAD) / Q192 : (WAD * Q192) / (s * s);
}
function tickOf(sqrt: bigint): number {
  const r = Number(sqrt) / Number(Q96);
  return Math.floor(Math.log(r * r) / Math.log(1.0001));
}

/** The C5 numbers for a campaign that graduates after `soldWhole` tokens (Robinhood k = 850, b = 1e9). */
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

d("evmgen-rh: Robinhood V3 graduation adapters on a 4663 fork", function () {
  this.timeout(3_600_000);

  let deployer: any;
  let griefOwner: any;
  let native: any;
  let stock: any;
  let locker: any;
  let factory: any;
  let v3: any;
  let npm: any;
  let weth: any;
  let spy: any;
  let base: string;
  let spyFeed: string;
  const gas: Record<string, bigint> = {};

  async function snapshot(): Promise<string> {
    return network.provider.send("evm_snapshot", []);
  }
  async function restore(id: string) {
    await network.provider.send("evm_revert", [id]);
  }

  before(async () => {
    [deployer, griefOwner] = await ethers.getSigners();
    // EDR lesson (CLAUDE.md): mine one local block before reading a forked chain it has no history for.
    await network.provider.send("evm_mine", []);

    v3 = await ethers.getContractAt(V3_FACTORY_ABI, RH.v3Factory);
    npm = await ethers.getContractAt(NPM_ABI, RH.npm);
    weth = await ethers.getContractAt(WETH_ABI, RH.weth);
    spy = await ethers.getContractAt(ERC20_ABI, RH.spy);

    const receiver = await (await ethers.getContractFactory("AcceptingReceiver")).deploy();
    locker = await (await ethers.getContractFactory("PermanentV3PositionLocker")).deploy(deployer.address);
    factory = await (await ethers.getContractFactory("MockEvmGenRhFactory")).deploy(await locker.getAddress());
    native = await (await ethers.getContractFactory("RobinhoodV3NativeGraduationAdapterV2")).deploy(RH.v3Factory, RH.npm, RH.weth, deployer.address);
    stock = await (await ethers.getContractFactory("RobinhoodStockGraduationAdapterV2")).deploy(
      RH.v3Factory,
      RH.npm,
      RH.swapRouter,
      RH.weth,
      RH.ethUsd,
      90_000,
      deployer.address,
    );
    await locker.configureRevenue(await receiver.getAddress(), await native.getAddress());
    await locker.setIntegrationSourceAuthorized(await stock.getAddress(), true);
    await native.setCampaignFactoryOnce(await factory.getAddress());
    await stock.setCampaignFactoryOnce(await factory.getAddress());
    // Stock feeds update about once per trading day; on a weekend or before the open the real SPY feed
    // exceeds the 90,000 s max age. Then (and only then) mirror its live answer into a fresh mock so the
    // stock path can still be exercised; the stale-feed test uses the real behaviour either way.
    spyFeed = RH.spyFeed;
    const feed = await ethers.getContractAt(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"], RH.spyFeed);
    const [, spyAnswer, , spyUpdated] = await feed.latestRoundData();
    const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    if (now - spyUpdated > 85_000n) {
      const mock = await (await ethers.getContractFactory("MockUsdPriceFeed")).deploy(await feed.decimals());
      await mock.setRoundData(1, spyAnswer, now, now, 1);
      spyFeed = await mock.getAddress();
      console.log(`      SPY feed is ${now - spyUpdated}s old at the fork block: mirrored answer ${spyAnswer} into a fresh mock`);
    } else {
      console.log(`      SPY feed age at the fork block: ${now - spyUpdated}s (real feed used)`);
    }
    await stock.configureStockRoute(RH.spy, {
      oracleFeed: spyFeed,
      acquisitionPool: RH.spyPool,
      acquisitionFeeTier: 500,
      minimumRouteLiquidityUsdWad: 50_000n * WAD,
      maxSwapSlippageBps: 100,
      maxOracleDeviationBps: 0,
      maxPriceImpactBps: 0,
      enabled: true,
    });
    base = await snapshot();
  });

  beforeEach(async () => {
    await restore(base);
    base = await snapshot();
  });

  after(() => {
    console.log("\n      graduation gas (campaign.graduate / repairPool tx gasUsed):");
    for (const [k, v] of Object.entries(gas)) console.log(`        ${k.padEnd(56)} ${v}`);
  });

  /** A harness campaign whose LaunchToken sorts below (`memeIs0`) or above `paired`. */
  async function newCampaign(paired: string, memeIs0: boolean) {
    const campaign = await (await ethers.getContractFactory("MockEvmGenRhCampaign")).deploy();
    const cAddr = await campaign.getAddress();
    const tokenFactory = await ethers.getContractFactory("LaunchToken");
    const initCode =
      tokenFactory.bytecode +
      ethers.AbiCoder.defaultAbiCoder().encode(["string", "string", "uint256", "address"], ["Meme", "MEME", SUPPLY, cAddr]).slice(2);
    const codeHash = ethers.keccak256(initCode);
    const pairedN = BigInt(paired);
    for (let i = 0; i < 100_000; i++) {
      const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const predicted = ethers.getCreate2Address(cAddr, salt, codeHash);
      if ((BigInt(predicted) < pairedN) === memeIs0) {
        await campaign.init(salt, SUPPLY);
        expect((await campaign.token()).toLowerCase()).to.equal(predicted.toLowerCase());
        await factory.setCampaign(cAddr, true);
        const meme = await ethers.getContractAt([...ERC20_ABI, "function tradingEnabled() view returns (bool)"], predicted);
        return { campaign, cAddr, meme, memeAddr: predicted };
      }
    }
    throw new Error("no salt");
  }

  async function poolOf(meme: string, paired: string) {
    return ethers.getContractAt(POOL_ABI, await v3.getPool(meme, paired, 3000));
  }

  async function createAndInit(meme: string, paired: string, pricePairedPerMemeWad: bigint | null) {
    await v3.createPool(meme, paired, 3000);
    const pool = await poolOf(meme, paired);
    if (pricePairedPerMemeWad !== null) {
      await pool.initialize(sqrtFromPrice(pricePairedPerMemeWad, BigInt(meme) < BigInt(paired)));
    }
    return pool;
  }

  async function griefer(pairedToken: any, amount: bigint) {
    const g = await (await ethers.getContractFactory("MockEvmGenRhGriefer")).deploy();
    if (pairedToken === weth) {
      await weth.connect(griefOwner).deposit({ value: amount });
      await weth.connect(griefOwner).transfer(await g.getAddress(), amount);
    } else {
      await pairedToken.connect(griefOwner).transfer(await g.getAddress(), amount);
    }
    return g;
  }

  /** Q-only bids between two MEME prices (paired per MEME, wad), strictly inside, `width` ticks each. */
  function ladder(memeIs0: boolean, priceA: bigint, priceB: bigint, width: number) {
    const ta = tickOf(sqrtFromPrice(priceA, memeIs0));
    const tb = tickOf(sqrtFromPrice(priceB, memeIs0));
    const lo = Math.min(ta, tb);
    const hi = Math.max(ta, tb);
    const first = (Math.floor(lo / 60) + 2) * 60;
    const last = (Math.floor(hi / 60) - 1) * 60;
    const count = Math.floor((last - first) / width);
    if (count <= 0) throw new Error("empty ladder");
    return { first, count };
  }

  async function buySpy(to: any, wethIn: bigint) {
    await weth.connect(to).deposit({ value: wethIn });
    await weth.connect(to).approve(RH.swapRouter, wethIn);
    const router = await ethers.getContractAt(ROUTER_ABI, RH.swapRouter);
    await (router.connect(to) as any).exactInputSingle({
      tokenIn: RH.weth,
      tokenOut: RH.spy,
      fee: 500,
      recipient: to.address,
      amountIn: wethIn,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    });
  }

  /** Graduate through the harness and check every C5/C7 invariant that holds for all cases. */
  async function graduateAndCheck(
    label: string,
    ctx: { campaign: any; cAddr: string; meme: any; memeAddr: string },
    adapter: any,
    pairedToken: any,
    quoteAddr: string,
    c: ReturnType<typeof curve>,
    opts: { expectExhausted?: boolean } = {},
  ) {
    const adapterAddr = await adapter.getAddress();
    const pairedAddr = quoteAddr === ethers.ZeroAddress ? RH.weth : quoteAddr;
    const memeIs0 = BigInt(ctx.memeAddr) < BigInt(pairedAddr);
    const stepSold: bigint = await ctx.campaign.repairMemeSold();
    const stepNative: bigint = await ctx.campaign.repairNativeProceeds();
    await deployer.sendTransaction({ to: ctx.cAddr, value: c.poolNative });

    const poolAddrBefore = await v3.getPool(ctx.memeAddr, pairedAddr, 3000);
    const poolPairedBefore = poolAddrBefore === ethers.ZeroAddress ? 0n : await pairedToken.balanceOf(poolAddrBefore);
    const poolMemeBefore = poolAddrBefore === ethers.ZeroAddress ? 0n : await ctx.meme.balanceOf(poolAddrBefore);
    const campaignMemeBefore = await ctx.meme.balanceOf(ctx.cAddr);

    dbg("graduate: sending");
    const tx = await ctx.campaign.graduate(adapterAddr, quoteAddr, c.T, c.budget, c.P, c.poolNative);
    const rc = await tx.wait();
    gas[label] = rc.gasUsed;
    const res = await ctx.campaign.lastResult();
    const memeBack: bigint = await ctx.campaign.lastMemeBack();
    const memeUsed: bigint = await ctx.campaign.lastMemeUsed();
    const nativeBack: bigint = await ctx.campaign.lastNativeBack();
    const memeMax = c.budget - stepSold;

    // Adapter holds nothing afterwards.
    expect(await weth.balanceOf(adapterAddr)).to.equal(0n);
    expect(await ctx.meme.balanceOf(adapterAddr)).to.equal(0n);
    expect(await spy.balanceOf(adapterAddr)).to.equal(0n);
    expect(await ethers.provider.getBalance(adapterAddr)).to.equal(0n);
    expect(await ctx.meme.allowance(ctx.cAddr, adapterAddr)).to.equal(0n);

    // MEME conservation: used + returned == pulled budget; all used MEME sits in the pool.
    expect(memeUsed + memeBack).to.equal(memeMax);
    expect(campaignMemeBefore - (await ctx.meme.balanceOf(ctx.cAddr))).to.equal(memeUsed);
    expect(res.memeUsed).to.equal(memeUsed);
    const pool = await ethers.getContractAt(POOL_ABI, res.pool);
    expect(res.pool).to.equal(await v3.getPool(ctx.memeAddr, pairedAddr, 3000));
    expect((await ctx.meme.balanceOf(res.pool)) - poolMemeBefore).to.equal(memeUsed);
    expect(poolMemeBefore).to.equal(stepSold); // only earlier repair steps ever put MEME in

    // Paired conservation into the pool.
    if (quoteAddr === ethers.ZeroAddress) {
      const nativeIn = c.poolNative + stepNative;
      expect((await weth.balanceOf(res.pool)) - poolPairedBefore).to.equal(nativeIn - nativeBack);
    }

    // Locked: the locker owns the full-range 0.30% NFT and recorded it for this pool.
    expect(await npm.ownerOf(res.positionId)).to.equal(await locker.getAddress());
    expect(await locker.pendingPositionByPool(res.pool)).to.equal(res.positionId);
    const pos = await npm.positions(res.positionId);
    expect(pos.fee).to.equal(3000n);
    expect(pos.tickLower).to.equal(-887220n);
    expect(pos.tickUpper).to.equal(887220n);
    expect(pos.liquidity).to.equal(res.liquidity);

    // Price.
    const slot = await pool.slot0();
    const start = priceFromSqrt(slot.sqrtPriceX96, memeIs0);
    const exhausted = memeBack <= MAX_MEME_DUST;
    if (quoteAddr === ethers.ZeroAddress) {
      const target = sqrtFromPrice(c.P, memeIs0);
      if (!opts.expectExhausted) {
        expect(slot.sqrtPriceX96).to.equal(target);
        // start == P within the sqrt rounding (relative < 1e-15)
        const diff = start > c.P ? start - c.P : c.P - start;
        expect(diff * 10n ** 9n).to.be.lte(c.P); // start == P up to 1 wei of sqrt rounding
      } else {
        expect(exhausted).to.equal(true);
        expect(slot.sqrtPriceX96 === target || start >= c.P).to.equal(true);
      }
      // C5 1.9: nativeBack <= 1 bp unless the budget was used up.
      if (!exhausted) expect(nativeBack * 10_000n).to.be.lte(c.poolNative + stepNative);
    }
    // The repair only ever sells at >= 0.997 * P (before fee: >= P).
    if (res.repairMemeSold > 0n && quoteAddr === ethers.ZeroAddress) {
      expect(res.repairProceeds * 1000n * WAD).to.be.gte(997n * c.P * res.repairMemeSold);
    }
    return { res, memeBack, memeUsed, nativeBack, start, slot, memeIs0, rc };
  }

  // ------------------------------------------------------------------------------------------ native

  for (const memeIs0 of [true, false]) {
    const ord = memeIs0 ? "MEME<WETH" : "MEME>WETH";

    it(`native ${ord}: no pool -> created at the curve price`, async () => {
      const ctx = await newCampaign(RH.weth, memeIs0);
      const c = curve(160_000_000n);
      const out = await graduateAndCheck(`native ${ord} no pool`, ctx, native, weth, ethers.ZeroAddress, c);
      expect(out.res.repaired).to.equal(false);
      expect(out.nativeBack * 10_000n).to.be.lte(c.poolNative);
    });

    it(`native ${ord}: pool created but uninitialized`, async () => {
      const ctx = await newCampaign(RH.weth, memeIs0);
      const c = curve(160_000_000n);
      await createAndInit(ctx.memeAddr, RH.weth, null);
      const out = await graduateAndCheck(`native ${ord} uninitialized`, ctx, native, weth, ethers.ZeroAddress, c);
      expect(out.res.repaired).to.equal(false);
    });

    for (const [name, mul, div] of [
      ["1/1000x", 1n, 1000n],
      ["1000x", 1000n, 1n],
    ] as const) {
      it(`native ${ord}: empty pool pre-initialized at ${name} -> moved for free`, async () => {
        const ctx = await newCampaign(RH.weth, memeIs0);
        const c = curve(160_000_000n);
        await createAndInit(ctx.memeAddr, RH.weth, (c.P * mul) / div);
        const out = await graduateAndCheck(`native ${ord} empty @${name}`, ctx, native, weth, ethers.ZeroAddress, c);
        expect(out.res.repaired).to.equal(false); // nothing sold, nothing bought
        expect(out.res.repairMemeSold).to.equal(0n);
        expect(out.res.repairProceeds).to.equal(0n);
      });
    }

    it(`native ${ord}: griefer WETH bids between P and 1000x -> filled at >= P, pool at P`, async () => {
      const ctx = await newCampaign(RH.weth, memeIs0);
      const c = curve(160_000_000n);
      const pool = await createAndInit(ctx.memeAddr, RH.weth, c.P * 1000n);
      dbg("pool init");
      const g = await griefer(weth, ethers.parseEther("5"));
      dbg("griefer funded");
      const { first } = ladder(memeIs0, c.P * 2n, c.P * 900n, 600);
      dbg(`ladder first ${first}`);
      await g.mintLadder(await pool.getAddress(), first, 600, 5, 10n ** 20n);
      dbg("bids minted");
      const gWethBefore = await weth.balanceOf(await g.getAddress());
      const out = await graduateAndCheck(`native ${ord} bids small`, ctx, native, weth, ethers.ZeroAddress, c);
      expect(out.res.repaired).to.equal(true);
      expect(out.res.repairMemeSold).to.be.gt(0n);
      expect(out.res.repairProceeds).to.be.gt(0n);
      expect(out.res.donationFound).to.equal(ethers.parseEther("5") - gWethBefore);
    });

    it(`native ${ord}: bids below P only -> not touched, pool at P`, async () => {
      const ctx = await newCampaign(RH.weth, memeIs0);
      const c = curve(160_000_000n);
      const pool = await createAndInit(ctx.memeAddr, RH.weth, c.P * 1000n);
      const g = await griefer(weth, ethers.parseEther("1"));
      const { first } = ladder(memeIs0, c.P / 100n, c.P / 2n, 600);
      // Bids at MEME prices below P (and below the current 1000x): never reached by the repair.
      await g.mintLadder(await pool.getAddress(), first, 600, 3, 10n ** 15n);
      const out = await graduateAndCheck(`native ${ord} bids below P`, ctx, native, weth, ethers.ZeroAddress, c);
      expect(out.res.repairMemeSold).to.equal(0n);
    });

    for (const [size, liq, fund] of [
      ["larger than the spare", 10n ** 23n, "400"],
      ["far larger than the whole budget", 3n * 10n ** 24n, "3000"],
    ] as const) {
      it(`native ${ord}: sold-out campaign, bids ${size} -> phase 2, MEME binds, no freeze`, async () => {
        const ctx = await newCampaign(RH.weth, memeIs0);
        const c = curve(700_000_000n); // sold out: spare = budget - T is only ~6.6M tokens
        const spare = c.budget - c.T;
        expect(spare * 20n).to.be.lt(c.T);
        const pool = await createAndInit(ctx.memeAddr, RH.weth, c.P * 1000n);
        const g = await griefer(weth, ethers.parseEther(fund));
        // One wide bid between 1.5P and 3P.
        const { first, count } = ladder(memeIs0, (c.P * 3n) / 2n, c.P * 3n, 60);
        await g.mintLadder(await pool.getAddress(), first, 60 * count, 1, liq);
        const out = await graduateAndCheck(`native ${ord} exhausted, bids ${size}`, ctx, native, weth, ethers.ZeroAddress, c, {
          expectExhausted: true,
        });
        expect(out.res.repairMemeSold).to.be.gt(spare); // phase 2 sold beyond the spare
        expect(out.memeBack).to.equal(0n); // memeUsed == memeMax exactly (dust went to the pool)
        expect(out.start * 10_000n).to.be.gte(c.P * 9_950n); // never below the band
        expect(out.nativeBack).to.be.gt(0n); // surplus to the creator's pull balance (C5 1.10)
        console.log(
          `        ${ord} exhausted (${size}): start/P = ${Number((out.start * 10_000n) / c.P) / 10_000}, sold ${ethers.formatEther(out.res.repairMemeSold)} MEME (spare ${ethers.formatEther(spare)}), nativeBack=${ethers.formatEther(out.nativeBack)} ETH`,
        );
      });
    }

    it(`native ${ord}: griefer attacks fail (MEME-bearing mint, MEME transfer, push price back mid-repair)`, async () => {
      const ctx = await newCampaign(RH.weth, memeIs0);
      const c = curve(160_000_000n);
      const pool = await createAndInit(ctx.memeAddr, RH.weth, c.P * 1000n);
      const poolAddr = await pool.getAddress();
      const g = await griefer(weth, ethers.parseEther("5"));
      const gAddr = await g.getAddress();
      await ctx.campaign.giveMeme(gAddr, 10n ** 24n); // the griefer bought on the curve
      // 1. A position around the current price needs MEME: LaunchToken refuses the transfer.
      const cur = Number((await pool.slot0()).tick);
      const around = Math.floor(cur / 60) * 60;
      await expect(g.mintRange(poolAddr, around - 600, around + 600, 10n ** 15n)).to.be.reverted;
      // 2. Direct MEME transfer to the pool.
      await expect(g.withdraw(ctx.memeAddr, poolAddr)).to.be.reverted;
      // 3. Bids, one chunk of repair, then try to push the price back up through the filled range.
      const { first } = ladder(memeIs0, c.P * 2n, c.P * 900n, 600);
      await g.mintLadder(poolAddr, first, 600, 5, 10n ** 16n);
      const before = (await pool.slot0()).sqrtPriceX96;
      const mid = sqrtFromPrice((c.P * 3n) / 2n, memeIs0); // past every bid, short of P
      await ctx.campaign.repairPool(await native.getAddress(), ethers.ZeroAddress, c.T, c.budget, c.P, mid);
      const afterStep = (await pool.slot0()).sqrtPriceX96;
      expect(afterStep).to.equal(mid);
      expect(await ctx.meme.balanceOf(poolAddr)).to.be.gt(0n); // repair sold MEME into bids
      // Moving back toward the old price means buying MEME out of the pool: the transfer is refused.
      const zeroForOne = !memeIs0; // paired in
      const back = memeIs0 ? before - 1n : before + 1n;
      await expect(g.swapExactIn(poolAddr, zeroForOne, 10n ** 17n, back)).to.be.reverted;
      // The graduation still completes from where the chunk left the pool.
      await graduateAndCheck(`native ${ord} after 1 chunk`, ctx, native, weth, ethers.ZeroAddress, c);
    });
  }

  it("native: wrong-price pools at fee 500 and 10000 are ignored", async () => {
    const ctx = await newCampaign(RH.weth, false);
    const c = curve(160_000_000n);
    const memeIs0 = BigInt(ctx.memeAddr) < BigInt(RH.weth);
    for (const fee of [500, 10000]) {
      await v3.createPool(ctx.memeAddr, RH.weth, fee);
      const p = await ethers.getContractAt(POOL_ABI, await v3.getPool(ctx.memeAddr, RH.weth, fee));
      await p.initialize(sqrtFromPrice(c.P * 1000n, memeIs0));
    }
    const out = await graduateAndCheck("native fee-500/10000 decoys", ctx, native, weth, ethers.ZeroAddress, c);
    expect(out.res.repaired).to.equal(false);
  });

  // Heavy tick seeding. The default seeds RH_HEAVY_TICKS (400) one-tick bids, measures the gas each
  // crossing costs, extrapolates how many ticks push a one-shot graduation past the 32M Nitro cap,
  // shows a one-shot given less gas than the crossings need reverts (the scaled stand-in for the cap),
  // then repairs in chunks through the campaign and graduates cheaply.
  (process.env.RH_SKIP_HEAVY ? it.skip : it)("native: heavy tick seeding -> one-shot gas grows per tick; repairPool chunks, then graduate succeeds", async () => {
    const memeIs0 = false; // the ordering every realistic MEME has against WETH 0x0Bd7...
    const ctx = await newCampaign(RH.weth, memeIs0);
    const c = curve(160_000_000n);
    const pool = await createAndInit(ctx.memeAddr, RH.weth, c.P * 20_000n);
    const poolAddr = await pool.getAddress();
    const g = await griefer(weth, ethers.parseEther("50"));
    const { first, count } = ladder(memeIs0, c.P * 2n, c.P * 19_000n, 60);
    const N = Math.min(Number(process.env.RH_HEAVY_TICKS || 400), count);
    for (let i = 0; i < N; i += 50) {
      await g.mintLadder(poolAddr, first + i * 60, 60, Math.min(50, N - i), 10n ** 14n, { gasLimit: 16_000_000 });
      dbg(`seeded ${Math.min(i + 50, N)}`);
    }
    await deployer.sendTransaction({ to: ctx.cAddr, value: c.poolNative });
    const pre = await snapshot();

    // One shot with ample gas: measure.
    const tx1 = await ctx.campaign.graduate(await native.getAddress(), ethers.ZeroAddress, c.T, c.budget, c.P, c.poolNative, { gasLimit: 32_000_000 });
    const g1 = (await tx1.wait()).gasUsed;
    const baseline = 1_430_000n; // "bids small" graduation above
    const perTick = (g1 - baseline) / BigInt(N + 1);
    const ticksFor32M = (32_000_000n - baseline) / perTick;
    gas[`native one-shot through ${N + 1} initialized ticks`] = g1;
    console.log(`        ${N + 1} ticks one-shot: ${g1} gas, ~${perTick} gas per crossed tick -> ~${ticksFor32M} ticks exceed the 32M cap`);
    await restore(pre);

    // Given less gas than the crossings need: reverts, and the coin stays repairable.
    await expect(
      ctx.campaign.graduate(await native.getAddress(), ethers.ZeroAddress, c.T, c.budget, c.P, c.poolNative, { gasLimit: baseline + (g1 - baseline) / 2n }),
    ).to.be.reverted;

    // Chunked: repairPool steps each crossing about a quarter of the ticks, then graduate.
    const sqrtT = sqrtFromPrice(c.P, memeIs0);
    const span = Math.ceil((N * 60) / 4) + 60;
    let steps = 0;
    let maxStepGas = 0n;
    let lastGas = 32_000_000n;
    for (;;) {
      const cur = (await pool.slot0()).sqrtPriceX96;
      if (cur === sqrtT) break;
      const stepTick = tickOf(cur) + span; // MEME>WETH: moving toward P raises the raw price
      let limit = BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, stepTick)) * Number(Q96)));
      // Last chunk (all the way to P) once past the target or once a chunk crossed no bids.
      if (limit >= sqrtT || lastGas < 1_000_000n) limit = 0n;
      const tx = await ctx.campaign.repairPool(await native.getAddress(), ethers.ZeroAddress, c.T, c.budget, c.P, limit, { gasLimit: 32_000_000 });
      const rc = await tx.wait();
      dbg(`step ${steps} gas ${rc.gasUsed}`);
      lastGas = rc.gasUsed;
      if (rc.gasUsed > maxStepGas) maxStepGas = rc.gasUsed;
      steps++;
      if (steps > 12) throw new Error("repair did not converge");
    }
    expect(steps).to.be.gte(3);
    gas[`native repairPool max step (${steps} steps)`] = maxStepGas;
    console.log(`        ${steps} repairPool steps, max ${maxStepGas} gas each`);
    expect(await ctx.campaign.repairMemeSold()).to.be.gt(0n);
    expect(await ctx.campaign.repairNativeProceeds()).to.be.gt(0n);
    // The graduation after the chunks carries the native proceeds back in msg.value.
    const out = await graduateAndCheck("native after chunked repair", ctx, native, weth, ethers.ZeroAddress, c);
    expect(out.res.repaired).to.equal(true);
    expect(out.rc.gasUsed).to.be.lt(g1);
  });

  // ------------------------------------------------------------------------------------------ stock

  async function stockGraduate(label: string, memeIs0: boolean, setup?: (ctx: any, c: any) => Promise<void>) {
    const ctx = await newCampaign(RH.spy, memeIs0);
    const c = curve(160_000_000n);
    if (setup) await setup(ctx, c);
    const spyBefore = await spy.balanceOf(ctx.cAddr);
    const out = await graduateAndCheck(label, ctx, stock, spy, RH.spy, c);
    const quoteBack = (await spy.balanceOf(ctx.cAddr)) - spyBefore;
    const ev = (await stock.queryFilter(stock.filters.StockAcquired(), out.rc.blockNumber, out.rc.blockNumber))[0];
    const acquired: bigint = ev.args.stockOut;
    const oracleOut: bigint = ev.args.oracleStockOut;
    // STOCK conservation: acquired (+ earlier step proceeds) == used in the position + returned.
    expect(out.res.pairedUsed + quoteBack).to.equal(acquired + out.res.repairProceeds);
    // USD continuity within the 200 bps quote band (E11).
    const nativeUsd = BigInt((await (await ethers.getContractAt(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], RH.ethUsd)).latestRoundData())[1]) * 10n ** 10n;
    const spyUsd = BigInt((await (await ethers.getContractAt(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], spyFeed)).latestRoundData())[1]) * 10n ** 10n;
    const startUsd = (out.start * spyUsd) / WAD;
    const curveUsd = (c.P * nativeUsd) / WAD;
    const devBps = Number(((startUsd - curveUsd) * 1_000_000n) / curveUsd) / 100;
    console.log(
      `        ${label}: acquired ${ethers.formatEther(acquired)} SPY vs oracle ${ethers.formatEther(oracleOut)} (${Number(((acquired - oracleOut) * 1_000_000n) / oracleOut) / 100} bps), start vs curve USD ${devBps} bps, SPY back ${quoteBack} wei, MEME back ${out.memeBack}`,
    );
    expect(Math.abs(devBps)).to.be.lte(200);
    return { ...out, acquired, oracleOut, quoteBack, ctx, c };
  }

  for (const memeIs0 of [true, false]) {
    const ord = memeIs0 ? "MEME<SPY" : "MEME>SPY";
    it(`stock ${ord}: no pool -> acquisition at the oracle minimum, pool at P_Q, dust returned without revert`, async () => {
      const out = await stockGraduate(`stock ${ord} no pool`, memeIs0);
      expect(out.res.repaired).to.equal(false);
      expect(out.acquired).to.be.gte((out.oracleOut * 9700n) / 10_000n);
    });

    it(`stock ${ord}: pre-made MEME/SPY pool at 1000x with SPY bids -> repaired`, async () => {
      const out = await stockGraduate(`stock ${ord} bids`, memeIs0, async (ctx, c) => {
        await buySpy(griefOwner, ethers.parseEther("2"));
        const spyBal = await spy.balanceOf(griefOwner.address);
        // MEME price in SPY per MEME ~ P * ETHUSD / SPYUSD; init 1000x above it.
        const est = (c.P * 2694n) / 766n;
        const pool = await createAndInit(ctx.memeAddr, RH.spy, est * 1000n);
        const g = await griefer(spy, spyBal);
        const { first } = ladder(memeIs0, est * 2n, est * 900n, 600);
        await g.mintLadder(await pool.getAddress(), first, 600, 4, 10n ** 16n);
      });
      expect(out.res.repaired).to.equal(true);
      expect(out.res.repairMemeSold).to.be.gt(0n);
    });
  }

  it("stock E11: a route through a 1% pool (fee 10000) is refused; the 200 bps band is in force", async () => {
    expect(await stock.QUOTE_PRICE_BAND_BPS()).to.equal(200n);
    const route = await stock.stockRoutes(RH.spy);
    const pool10000 = await v3.getPool(RH.weth, RH.spy, 10000);
    await expect(
      stock.configureStockRoute(RH.spy, {
        oracleFeed: route[0],
        acquisitionPool: pool10000 === ethers.ZeroAddress ? route[1] : pool10000,
        acquisitionFeeTier: 10000,
        minimumRouteLiquidityUsdWad: route[3],
        maxSwapSlippageBps: route[4],
        maxOracleDeviationBps: 0,
        maxPriceImpactBps: 0,
        enabled: true,
      }),
    ).to.be.revertedWithCustomError(stock, "InvalidFeeTier");
  });

  it("stock: stale SPY feed -> OracleStale, campaign stays retryable; retry on a fresh round succeeds", async () => {
    const ctx = await newCampaign(RH.spy, false);
    const c = curve(160_000_000n);
    await deployer.sendTransaction({ to: ctx.cAddr, value: c.poolNative });
    const id = await snapshot();
    await network.provider.send("evm_increaseTime", [100_000]);
    await network.provider.send("evm_mine", []);
    await expect(ctx.campaign.graduate(await stock.getAddress(), RH.spy, c.T, c.budget, c.P, c.poolNative)).to.be.revertedWithCustomError(
      stock,
      "OracleStale",
    );
    await restore(id); // stands in for "the next round arrives"
    await ctx.campaign.graduate(await stock.getAddress(), RH.spy, c.T, c.budget, c.P, c.poolNative);
    expect(await npm.ownerOf((await ctx.campaign.lastResult()).positionId)).to.equal(await locker.getAddress());
  });

  it("stock: acquisition sandwich beyond the oracle bound reverts; inside it the adapter still gets >= oracle*(1-3%)", async () => {
    const ctx = await newCampaign(RH.spy, false);
    const c = curve(160_000_000n);
    await deployer.sendTransaction({ to: ctx.cAddr, value: c.poolNative });
    const [minOut] = [(await stock.oracleMinimumStockOut(RH.spy, c.poolNative)).minimumOut];
    const id = await snapshot();
    // Front-run hard: dump a large WETH buy of SPY into the acquisition pool.
    await buySpy(griefOwner, ethers.parseEther("150"));
    await expect(ctx.campaign.graduate(await stock.getAddress(), RH.spy, c.T, c.budget, c.P, c.poolNative)).to.be.reverted;
    await restore(id);
    // A small front-run stays inside the bound; whatever the adapter gets is >= the oracle minimum.
    await buySpy(griefOwner, ethers.parseEther("1"));
    const tx = await ctx.campaign.graduate(await stock.getAddress(), RH.spy, c.T, c.budget, c.P, c.poolNative).catch((e: any) => e);
    if (tx instanceof Error) {
      // Allowed outcome: the 200 bps continuity band refuses, the campaign stays Pending.
      expect(String(tx.message)).to.match(/PriceContinuityFailed|reverted/);
    } else {
      const rc = await tx.wait();
      const ev = (await stock.queryFilter(stock.filters.StockAcquired(), rc.blockNumber, rc.blockNumber))[0];
      expect(ev.args.stockOut).to.be.gte(minOut);
    }
  });
});
