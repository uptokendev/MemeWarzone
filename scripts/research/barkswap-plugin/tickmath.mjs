// Exact BigInt port of Uniswap V3 TickMath.getSqrtRatioAtTick, plus helpers. Research only.
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;
export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
const MAX_UINT256 = (1n << 256n) - 1n;

const C = [
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

export function getSqrtRatioAtTick(tick) {
  const absTick = Math.abs(tick);
  if (absTick > MAX_TICK) throw new Error("T");
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, c] of C) if ((absTick & bit) !== 0) ratio = (ratio * c) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Greatest tick whose sqrt ratio is <= sqrtPriceX96 (TickMath.getTickAtSqrtRatio semantics). */
export function getTickAtSqrtRatio(sqrtPriceX96) {
  let lo = MIN_TICK;
  let hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (getSqrtRatioAtTick(mid) <= sqrtPriceX96) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function isqrt(n) {
  if (n < 0n) throw new Error("neg");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/** sqrtPriceX96 for price = num / den (token1 per token0, raw units). */
export function sqrtX96FromRatio(num, den) {
  return isqrt((num * Q192) / den);
}

/** Real-valued tick of a price ratio, for nearest-grid snapping. */
export function realTick(num, den) {
  // log via 1e18-scaled float is fine here: the result is only used to pick a grid tick.
  const n = Number(num);
  const d = Number(den);
  return Math.log(n / d) / Math.log(1.0001);
}

export function snapNearest(tickReal, spacing) {
  return Math.round(tickReal / spacing) * spacing;
}

export function selfTest() {
  if (getSqrtRatioAtTick(MIN_TICK) !== MIN_SQRT_RATIO) throw new Error("TickMath MIN mismatch");
  if (getSqrtRatioAtTick(MAX_TICK) !== MAX_SQRT_RATIO) throw new Error("TickMath MAX mismatch");
  if (getSqrtRatioAtTick(0) !== Q96) throw new Error("TickMath 0 mismatch");
  return true;
}
