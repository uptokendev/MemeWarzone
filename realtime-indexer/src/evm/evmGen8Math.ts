/**
 * Exact integer maths for gen-8 pools (Uniswap V4, currency0 = native, currency1 = coin, design 2.2): price and
 * market cap from sqrtPriceX96 (no fill VWAP), curve progress from the pool price and position A's liquidity.
 * TickMath is the BigInt port the gen-8 tests use (test/gen8/fixtures/v4math.ts on build/evm-gen8).
 */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const WAD = 10n ** 18n;
export const GEN8_TOTAL_SUPPLY = 1_000_000_000n * WAD;
export const GEN8_COINS_A = 850_000_000n * WAD;
const MAX_UINT256 = (1n << 256n) - 1n;

const C: Array<[number, bigint]> = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** TickMath.getSqrtPriceAtTick. */
export function sqrtAtTick(tick: number): bigint {
  const absTick = Math.abs(tick);
  if (!Number.isInteger(tick) || absTick > MAX_TICK) throw new Error(`tick out of range: ${tick}`);
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, c] of C) if ((absTick & bit) !== 0) ratio = (ratio * c) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Native wei per whole coin (1e18 coin units) at sqrtPriceX96 (V4 price = coin per native). Floor. */
export function nativePerCoinWei(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  return (Q192 * WAD) / (sqrtPriceX96 * sqrtPriceX96);
}

/** The same price as a decimal number of native per coin (for the numeric price columns). */
export function nativePerCoin(sqrtPriceX96: bigint): number {
  const wei = nativePerCoinWei(sqrtPriceX96);
  return Number(wei) / 1e18;
}

/** Fully diluted market cap in native wei: price x 1B (gen-6/7 rule, factory_generation >= 6). */
export function marketCapWei(sqrtPriceX96: bigint): bigint {
  return (nativePerCoinWei(sqrtPriceX96) * GEN8_TOTAL_SUPPLY) / WAD;
}

/** Coins (raw) that position A releases between sqrtStart and sqrtP: L * (sqrtStart - sqrtP) / Q96, floor. */
export function coinsOutOfA(liqA: bigint, sqrtStart: bigint, sqrtP: bigint): bigint {
  if (sqrtP >= sqrtStart) return 0n;
  return (liqA * (sqrtStart - sqrtP)) / Q96;
}

export type Gen8Progress = { soldRaw: bigint; capacityRaw: bigint; bps: number; complete: boolean };

/**
 * Curve progress from the pool price (design 6.4: coins sold from A over A's coins, exact). Buying moves the price
 * down from sqrtStart (tickStart) to sqrtGrad (tickGrad); at or below sqrtGrad A is sold out. liqA is the
 * launch liquidity (PoolLaunched.liqA), so the result does not move when the latch removes 2% of A.
 */
export function gen8Progress(input: { liqA: bigint; tickStart: number; tickGrad: number; sqrtPriceX96: bigint; graduated?: boolean }): Gen8Progress {
  const sqrtStart = sqrtAtTick(input.tickStart);
  const sqrtGrad = sqrtAtTick(input.tickGrad);
  const capacityRaw = coinsOutOfA(input.liqA, sqrtStart, sqrtGrad);
  if (input.graduated || input.sqrtPriceX96 <= sqrtGrad) return { soldRaw: capacityRaw, capacityRaw, bps: 10_000, complete: true };
  const soldRaw = coinsOutOfA(input.liqA, sqrtStart, input.sqrtPriceX96);
  const bps = capacityRaw > 0n ? Number((soldRaw * 10_000n) / capacityRaw) : 0;
  return { soldRaw, capacityRaw, bps: Math.min(10_000, bps), complete: false };
}

export function rawToDecimal(raw: bigint, decimals = 18): number {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const n = Number(whole) + Number(frac) / Number(base);
  return neg ? -n : n;
}

export const MIN_USABLE_TICK = -887270;

function amount0Between(sqrtA: bigint, sqrtB: bigint, liq: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA <= 0n || liq <= 0n) return 0n;
  return ((liq << 96n) * (sqrtB - sqrtA)) / sqrtB / sqrtA;
}

function amount1Between(sqrtA: bigint, sqrtB: bigint, liq: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (liq * (sqrtB - sqrtA)) / Q96;
}

/** Native and coins one position [lower, upper] holds at sqrtP (floor). */
export function positionHoldings(sqrtLower: bigint, sqrtUpper: bigint, liq: bigint, sqrtP: bigint): { native: bigint; coins: bigint } {
  if (sqrtP <= sqrtLower) return { native: amount0Between(sqrtLower, sqrtUpper, liq), coins: 0n };
  if (sqrtP >= sqrtUpper) return { native: 0n, coins: amount1Between(sqrtLower, sqrtUpper, liq) };
  return { native: amount0Between(sqrtP, sqrtUpper, liq), coins: amount1Between(sqrtLower, sqrtP, liq) };
}

/**
 * What the pool holds in positions A [tickGrad, tickStart] and B [MIN_USABLE_TICK, tickGrad] (design 2.2). After the
 * latch A keeps liqA - floor(liqA * 2%) (GRAD_FEE_BPS 200); B never changes. Liquidity in native = native + coins x price.
 */
export function gen8PoolHoldings(input: { liqA: bigint; liqB: bigint; tickStart: number; tickGrad: number; sqrtPriceX96: bigint; graduated: boolean }) {
  const sqrtStart = sqrtAtTick(input.tickStart);
  const sqrtGrad = sqrtAtTick(input.tickGrad);
  const sqrtMin = sqrtAtTick(MIN_USABLE_TICK);
  const liqA = input.graduated ? input.liqA - (input.liqA * 200n) / 10_000n : input.liqA;
  const a = positionHoldings(sqrtGrad, sqrtStart, liqA, input.sqrtPriceX96);
  const b = positionHoldings(sqrtMin, sqrtGrad, input.liqB, input.sqrtPriceX96);
  const native = a.native + b.native;
  const coins = a.coins + b.coins;
  const liquidityNativeWei = native + (coins * nativePerCoinWei(input.sqrtPriceX96)) / WAD;
  return { native, coins, liquidityNativeWei };
}
