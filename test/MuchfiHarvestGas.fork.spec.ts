// t34 (gate 2 audit diff): re-measure the locker's MEME sale gas on MuchFi, so the MIN_SALE_GAS guard (500,000,
// measured on Robinhood Uniswap V3 at 0.30%: docs/evm-launch/spec/C1-C6-fees.md "Harvest gas guard") is proven to
// hold on a PancakeV3-fork pool at the 1% tier with a uint32 feeProtocol and the lmPool hook (currently unset).
//
//   npx hardhat --config hardhat.dogeos-testnet-fork.config.ts test test/MuchfiHarvestGas.fork.spec.ts
//
// Read-only: everything runs on the in-process Chikyū fork with hardhat's local funded accounts; nothing is sent to
// Chikyū and no key from config/dogeos.local is used. Under any other config the suite skips.
//
// Two scenarios, both a real harvest on a real MuchFi 1% MEME/WDOGE pool:
//   1. plain: the locker's full-range position is the only liquidity, the sale crosses no initialized tick;
//   2. pessimistic: a griefer's narrow WDOGE bid sits one tick spacing (200 ticks) away and the pool is steered so the
//      current tick is 5 ticks from its boundary; the sale (<= 0.5% impact, ~50 ticks) crosses that initialized tick.
// The sellMemeForPaired frame is read from the transaction trace (callTracer where the node offers it, otherwise the
// struct log: gas before the CALL to self minus gas at the next step back in the caller's frame, which also counts the
// CALL overhead and is therefore pessimistic). A third number, the frame called cold from the locker's own address,
// bounds it from above without any warm slots from the harvest.
import { expect } from "chai";
import { ethers } from "hardhat";
import type { Contract, Signer, TransactionReceipt } from "ethers";
import {
  MUCHFI,
  MUCHFI_FACTORY_ABI,
  MUCHFI_FEE,
  MUCHFI_MAX_TICK,
  MUCHFI_MIN_TICK,
  MUCHFI_NPM_ABI,
  MUCHFI_POOL_ABI,
  MUCHFI_SMART_ROUTER_ABI,
  MUCHFI_TICK_SPACING,
  WDOGE_ABI,
  skipUnlessChikyuFork,
} from "./helpers/muchfiFork";

const E18 = 10n ** 18n;
const HARVEST_GAS = 3_000_000n;
const MEME_RES = 1_000_000n * E18;
const PAIRED_RES = 1_000n * E18;

const NPM_ABI = [
  ...MUCHFI_NPM_ABI,
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
] as const;

/** Line-for-line BigInt port of @uniswap/v3-core TickMath.getSqrtRatioAtTick (cross-checked against MuchFi's own
 *  TickMath in test/MuchfiGraduationAdapter.fork.spec.ts). */
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

function parseEvents(contract: Contract, receipt: TransactionReceipt, name: string) {
  const address = String(contract.target).toLowerCase();
  return receipt.logs
    .filter((l) => l.address.toLowerCase() === address)
    .map((l) => {
      try {
        return contract.interface.parseLog({ topics: [...l.topics], data: l.data });
      } catch {
        return null;
      }
    })
    .filter((e) => e !== null && e.name === name) as NonNullable<ReturnType<Contract["interface"]["parseLog"]>>[];
}

type FrameGas = { frame: bigint; method: string };

/** Gas of the locker's self-call `sellMemeForPaired` inside `receipt`'s harvest. */
async function saleFrameGas(locker: Contract, receipt: TransactionReceipt): Promise<FrameGas> {
  const lockerAddress = (await locker.getAddress()).toLowerCase();
  const selector = locker.interface.getFunction("sellMemeForPaired")!.selector;
  try {
    const trace = await ethers.provider.send("debug_traceTransaction", [receipt.hash, { tracer: "callTracer" }]);
    const found: { gasUsed: string; error?: string }[] = [];
    const walk = (c: { to?: string; input?: string; gasUsed: string; error?: string; calls?: unknown[] }) => {
      if (String(c.to).toLowerCase() === lockerAddress && String(c.input).startsWith(selector)) found.push(c);
      for (const k of (c.calls || []) as Parameters<typeof walk>[0][]) walk(k);
    };
    walk(trace);
    if (found.length === 1 && found[0].error === undefined) return { frame: BigInt(found[0].gasUsed), method: "callTracer" };
  } catch {
    // Hardhat's node only offers the struct logger; fall through.
  }
  const trace = await ethers.provider.send("debug_traceTransaction", [receipt.hash, { disableMemory: true, disableStorage: true }]);
  const logs: { op: string; depth: number; gas: number; stack: string[] }[] = trace.structLogs;
  const lockerWord = BigInt(lockerAddress);
  for (let i = 0; i < logs.length - 1; i++) {
    const s = logs[i];
    if (s.op !== "CALL" || logs[i + 1].depth !== s.depth + 1) continue;
    const to = BigInt("0x" + s.stack[s.stack.length - 2].replace(/^0x/, ""));
    if (to !== lockerWord) continue;
    for (let j = i + 1; j < logs.length; j++) {
      if (logs[j].depth === s.depth) return { frame: BigInt(s.gas - logs[j].gas), method: "structLogs (CALL to self, includes CALL overhead)" };
    }
  }
  throw new Error("sellMemeForPaired frame not found in the trace");
}

describe("MuchfiV3PositionLocker on a Chikyū fork: MEME sale gas vs MIN_SALE_GAS (t34)", function () {
  let deployer: Signer;
  let griefer: Signer;
  let deployerAddress: string;
  let factory: Contract;
  let npm: Contract;
  let wdoge: Contract;
  let smartRouter: Contract;
  let integration: Contract;
  let meme: Contract;
  let memeAddress: string;
  let poolAddress: string;
  let pool: Contract;
  let memeIs0: boolean;
  let token0: string;
  let token1: string;

  async function deadline(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return Number(block!.timestamp) + 3600;
  }

  before(async function () {
    skipUnlessChikyuFork(this);
    [deployer, griefer] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    factory = new ethers.Contract(MUCHFI.FACTORY, MUCHFI_FACTORY_ABI, deployer);
    npm = new ethers.Contract(MUCHFI.NPM, NPM_ABI, deployer);
    wdoge = new ethers.Contract(MUCHFI.WDOGE, WDOGE_ABI, deployer);
    smartRouter = new ethers.Contract(MUCHFI.SMART_ROUTER, MUCHFI_SMART_ROUTER_ABI, deployer);
    await ethers.provider.send("hardhat_setBalance", [deployerAddress, "0x" + (1_000_000n * E18).toString(16)]);
    await (await wdoge.deposit({ value: 100_000n * E18 })).wait();
    await (await wdoge.approve(MUCHFI.NPM, ethers.MaxUint256)).wait();
    await (await wdoge.approve(MUCHFI.SMART_ROUTER, ethers.MaxUint256)).wait();
  });

  beforeEach(async function () {
    meme = (await (await ethers.getContractFactory("MockERC20"))
      .connect(deployer)
      .deploy("MuchFi Gas Meme", "MGM", 10n ** 30n, deployerAddress)) as unknown as Contract;
    await meme.waitForDeployment();
    memeAddress = await meme.getAddress();
    await (await meme.approve(MUCHFI.NPM, ethers.MaxUint256)).wait();
    await (await meme.approve(MUCHFI.SMART_ROUTER, ethers.MaxUint256)).wait();
    memeIs0 = BigInt(memeAddress) < BigInt(MUCHFI.WDOGE);
    [token0, token1] = memeIs0 ? [memeAddress, MUCHFI.WDOGE] : [MUCHFI.WDOGE, memeAddress];
    // 1 MEME = 0.001 WDOGE as a tick: ln(0.001)/ln(1.0001) = -69081 (memeIs0) or +69081.
    const initTick = memeIs0 ? -69081 : 69081;
    await (await npm.createAndInitializePoolIfNecessary(token0, token1, MUCHFI_FEE, getSqrtRatioAtTick(initTick))).wait();
    poolAddress = await factory.getPool(token0, token1, MUCHFI_FEE);
    expect(poolAddress).to.not.equal(ethers.ZeroAddress);
    pool = new ethers.Contract(poolAddress, MUCHFI_POOL_ABI, deployer);
    integration = (await (await ethers.getContractFactory("MuchfiForkLockerIntegration"))
      .connect(deployer)
      .deploy(MUCHFI.FACTORY, MUCHFI.NPM, MUCHFI.WDOGE)) as unknown as Contract;
    await integration.waitForDeployment();
  });

  async function lockPosition(): Promise<Contract> {
    const Receiver = await ethers.getContractFactory("TreasuryRouterV3ReceiverMock");
    const weekly = await Receiver.deploy();
    const monthly = await Receiver.deploy();
    const vault = await Receiver.deploy();
    const router = (await (await ethers.getContractFactory("TreasuryRouterV4")).deploy(
      deployerAddress,
      await weekly.getAddress(),
      await monthly.getAddress(),
      3600,
    )) as unknown as Contract;
    await (await router.setProtocolRevenueVault(await vault.getAddress())).wait();
    const locker = (await (await ethers.getContractFactory("MuchfiV3PositionLocker")).deploy(deployerAddress)) as unknown as Contract;
    await (await locker.configureRevenue(await router.getAddress(), await integration.getAddress())).wait();
    await (await router.setAuthorizedLpLocker(await locker.getAddress(), true)).wait();
    const mintReceipt = (await (
      await npm.mint({
        token0,
        token1,
        fee: MUCHFI_FEE,
        tickLower: MUCHFI_MIN_TICK,
        tickUpper: MUCHFI_MAX_TICK,
        amount0Desired: memeIs0 ? MEME_RES : PAIRED_RES,
        amount1Desired: memeIs0 ? PAIRED_RES : MEME_RES,
        amount0Min: 0,
        amount1Min: 0,
        recipient: await integration.getAddress(),
        deadline: await deadline(),
      })
    ).wait()) as TransactionReceipt;
    const minted = parseEvents(npm, mintReceipt, "Transfer");
    expect(minted).to.have.length(1);
    await (await integration.deliver(await locker.getAddress(), minted[0].args.tokenId)).wait();
    await (
      await locker.registerGraduatedPool(ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address, poolAddress, memeAddress, MUCHFI.WDOGE, 0n)
    ).wait();
    return locker;
  }

  /** Trader swap through the real SmartRouter; `limit` (optional) stops the pool exactly at that sqrt price. */
  async function routerSwap(tokenIn: string, amountIn: bigint, limit = 0n): Promise<void> {
    const tokenOut = tokenIn === memeAddress ? MUCHFI.WDOGE : memeAddress;
    await (
      await smartRouter.exactInputSingle({
        tokenIn,
        tokenOut,
        fee: MUCHFI_FEE,
        recipient: deployerAddress,
        amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: limit,
      })
    ).wait();
  }

  async function harvestAndMeasure(locker: Contract, label: string) {
    const minSaleGas: bigint = await locker.MIN_SALE_GAS();
    expect(minSaleGas).to.equal(500_000n);
    const receipt = (await (await locker.harvest(poolAddress, { gasLimit: HARVEST_GAS })).wait()) as TransactionReceipt;
    const sold = parseEvents(locker, receipt, "MemeFeesSold");
    expect(sold).to.have.length(1);
    expect(sold[0].args.memeSold as bigint).to.be.greaterThan(0n);
    expect(parseEvents(pool, receipt, "Swap")).to.have.length(1);
    const { frame, method } = await saleFrameGas(locker, receipt);
    console.log(
      `      MuchFi fork gas [${label}]: sellMemeForPaired frame ${frame} (${method}), whole harvest ${receipt.gasUsed}, MIN_SALE_GAS ${minSaleGas}, memeSold ${sold[0].args.memeSold}, carried ${sold[0].args.memeCarried}`,
    );
    // The same margin the BSC and Robinhood fork measurements assert: the guard leaves the sale 63/64 of MIN_SALE_GAS
    // (EIP-150), which must be at least twice what a real sale costs.
    expect(frame * 2n).to.be.lte((minSaleGas * 63n) / 64n);
    return { frame, receipt, memeSold: sold[0].args.memeSold as bigint };
  }

  it("plain harvest: the sale frame on a real MuchFi 1% pool stays under half of 63/64 x MIN_SALE_GAS", async function () {
    const locker = await lockPosition();
    await routerSwap(memeAddress, 200_000n * E18); // MEME-in: the LP fee accrues on the MEME side
    await routerSwap(MUCHFI.WDOGE, 10n * E18); // and a WDOGE fee, so _splitAndRoute pays both legs
    const { frame, memeSold } = await harvestAndMeasure(locker, "plain, no tick crossed");

    // Upper bound: the same frame called cold (no slot warmed by collect) from the locker's own address.
    const lockerAddress = await locker.getAddress();
    await (await meme.transfer(lockerAddress, memeSold)).wait();
    await ethers.provider.send("hardhat_impersonateAccount", [lockerAddress]);
    await ethers.provider.send("hardhat_setBalance", [lockerAddress, "0x" + E18.toString(16)]);
    const self = await ethers.getSigner(lockerAddress);
    const data = locker.interface.encodeFunctionData("sellMemeForPaired", [poolAddress, memeIs0, memeSold]);
    const cold = (await (await self.sendTransaction({ to: lockerAddress, data, gasLimit: 1_000_000n })).wait()) as TransactionReceipt;
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [lockerAddress]);
    const calldataGas = BigInt([...ethers.getBytes(data)].reduce((a, b) => a + (b === 0 ? 4 : 16), 0));
    const coldFrame = cold.gasUsed - 21_000n - calldataGas;
    console.log(`      MuchFi fork gas [cold standalone sellMemeForPaired]: ${coldFrame} (tx gasUsed ${cold.gasUsed})`);
    expect(coldFrame).to.be.gte(frame - 5_000n); // cold cannot be meaningfully cheaper than the in-harvest frame
    expect(coldFrame * 2n).to.be.lte((500_000n * 63n) / 64n);
  });

  it("pessimistic harvest: the sale crosses an initialized tick (a griefer's bid one spacing away) and still fits", async function () {
    const locker = await lockPosition();
    await routerSwap(memeAddress, 200_000n * E18);
    await routerSwap(MUCHFI.WDOGE, 10n * E18);

    // Steer the current tick to 5 ticks from the next multiple of 200 in the sale's direction (memeIs0: the sale sells
    // token0, the tick falls; otherwise it sells token1 and the tick rises), then put a WDOGE-only bid on the other side.
    const tickNow = Number((await pool.slot0()).tick);
    const base = memeIs0 ? Math.floor(tickNow / MUCHFI_TICK_SPACING) * MUCHFI_TICK_SPACING : Math.ceil(tickNow / MUCHFI_TICK_SPACING) * MUCHFI_TICK_SPACING;
    const target = memeIs0 ? base + 5 : base - 5;
    const limit = getSqrtRatioAtTick(target);
    const sqrtNow = (await pool.slot0()).sqrtPriceX96 as bigint;
    // A limited router swap in the direction of `target` stops the pool exactly there (partial fill).
    const sellToken0 = sqrtNow > limit; // zeroForOne lowers the price
    if (sqrtNow !== limit) await routerSwap(sellToken0 ? token0 : token1, 50_000n * E18, limit);
    expect((await pool.slot0()).sqrtPriceX96).to.equal(limit);
    expect(Number((await pool.slot0()).tick)).to.equal(target);

    const g = wdoge.connect(griefer) as Contract;
    await (await g.deposit({ value: 5n * E18 })).wait();
    await (await g.approve(MUCHFI.NPM, ethers.MaxUint256)).wait();
    const [lower, upper] = memeIs0 ? [base - MUCHFI_TICK_SPACING, base] : [base, base + MUCHFI_TICK_SPACING];
    await (
      await (npm.connect(griefer) as Contract).mint({
        token0,
        token1,
        fee: MUCHFI_FEE,
        tickLower: lower,
        tickUpper: upper,
        amount0Desired: memeIs0 ? 0n : 5n * E18,
        amount1Desired: memeIs0 ? 5n * E18 : 0n,
        amount0Min: 0,
        amount1Min: 0,
        recipient: await griefer.getAddress(),
        deadline: await deadline(),
      })
    ).wait();

    await harvestAndMeasure(locker, "one initialized tick crossed inside the 0.5% band");
    const tickAfter = Number((await pool.slot0()).tick);
    // The sale went through `base`: the griefer's tick was crossed.
    if (memeIs0) expect(tickAfter).to.be.lessThan(base);
    else expect(tickAfter).to.be.gte(base);
  });
});
