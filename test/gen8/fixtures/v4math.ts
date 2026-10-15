// Exact BigInt ports used by the gen-8 tests (from the research proof scripts/research/v4-hook/tickmath.mjs + lib.mjs).
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
export const Q96 = 1n << 96n;
export const Q192 = 1n << 192n;
export const WAD = 10n ** 18n;
export const BPS = 10_000n;
const MAX_UINT256 = (1n << 256n) - 1n;

const C: [number, bigint][] = [
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

export function sqrtAtTick(tick: number): bigint {
  const absTick = Math.abs(tick);
  if (absTick > MAX_TICK) throw new Error("T");
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, c] of C) if ((absTick & bit) !== 0) ratio = (ratio * c) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

export const MIN_USABLE_TICK = MIN_TICK + (-MIN_TICK % 10); // -887270

export const ceilDiv = (a: bigint, b: bigint) => a / b + (a % b === 0n ? 0n : 1n);
export const absDiff = (a: bigint, b: bigint) => (a > b ? a - b : b - a);
/** relative difference in parts per million */
export const ppm = (a: bigint, b: bigint) => (b === 0n ? 0 : Number((absDiff(a, b) * 10n ** 12n) / (b < 0n ? -b : b)) / 1e6);

export function amount0Delta(sqrtA: bigint, sqrtB: bigint, liq: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const n1 = liq << 96n;
  const n2 = sqrtB - sqrtA;
  if (!roundUp) return (n1 * n2) / sqrtB / sqrtA;
  return ceilDiv(ceilDiv(n1 * n2, sqrtB), sqrtA);
}

export function amount1Delta(sqrtA: bigint, sqrtB: bigint, liq: bigint, roundUp: boolean): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return roundUp ? ceilDiv(liq * (sqrtB - sqrtA), Q96) : (liq * (sqrtB - sqrtA)) / Q96;
}

export const mcFromSqrt = (sqrtP: bigint, supply: bigint) => (supply * Q192) / (sqrtP * sqrtP);

export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

// ---- gen-7 economics (LaunchFactoryGen7 / LaunchCampaignGen7), integer-exact
export const SUPPLY = 1_000_000_000n * WAD;
export const COINS_A = 850_000_000n * WAD;
export const COINS_B = 130_000_000n * WAD;
export const RESERVE = 20_000_000n * WAD;

export function gen7Curve(mc: bigint): { vN: bigint; vT: bigint } {
  const curve = (SUPPLY * 8500n) / BPS;
  const poolDesign = (((SUPPLY * 1300n) / BPS) * (BPS - 1n)) / BPS;
  const rn = poolDesign * BPS;
  const rd = (BPS - 200n) * curve;
  const vT = (curve * rd) / (rd - rn);
  const vN = (((((mc * vT) / SUPPLY) * rn) / rd) * rn) / rd;
  return { vN, vT };
}

/** gen-7 native the curve holds above vN after `s` sold: ceil(vN*vT/(vT-s)) - vN */
export const gen7CurveNative = (vN: bigint, vT: bigint, s: bigint) => ceilDiv(vN * vT, vT - s);
export const gen7MarketCap = (vN: bigint, vT: bigint, s: bigint) => (gen7CurveNative(vN, vT, s) * WAD) / (vT - s) * (SUPPLY / WAD);

/** gen-7 sell definition, exact output: smallest gross with gross - floor(gross*r/B) == net */
export function grossForNet(net: bigint, r: bigint): bigint {
  let g = ceilDiv(net * BPS, BPS - r);
  while (g > 0n && g - 1n - ((g - 1n) * r) / BPS >= net) g--;
  return g;
}

export function rateAt(dt: bigint, bonding = 200n, start = 9000n): bigint {
  if (dt >= 60n) return bonding;
  let left = 60n - dt;
  if (left > 60n) left = 60n;
  return bonding + ((start - bonding) * left) / 60n;
}
