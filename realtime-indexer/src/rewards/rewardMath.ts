const BNB = 10n ** 18n;

export const AIRDROP_WEIGHT_TIER_STEP = 1n * BNB;
export const SQUAD_DIMINISHING_FIRST_THRESHOLD = 100n * BNB;
export const SQUAD_DIMINISHING_SECOND_THRESHOLD = 200n * BNB;

export type ProRataItem = {
  key: string;
  weight: bigint;
};

export type CappedWeightItem = {
  key: string;
  weight: bigint;
  cap: bigint;
};

function sortItemsByKey<T extends { key: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.key.localeCompare(b.key));
}

export function bigintToString(value: bigint): string {
  return value.toString();
}

export function parseNumericBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;

  const s = String(value ?? "0").trim();
  if (!s) return 0n;

  if (/^[+-]?\d+$/.test(s)) {
    return BigInt(s);
  }

  const decimalMatch = /^([+-]?\d+)\.(\d+)$/.exec(s);
  if (decimalMatch) {
    const [, integerPart, fractionalPart] = decimalMatch;
    if (/^0+$/.test(fractionalPart)) {
      return BigInt(integerPart);
    }
    throw new RangeError(`Expected integer-valued numeric, received fractional value: ${s}`);
  }

  throw new SyntaxError(`Invalid integer-valued numeric: ${s}`);
}

export function allocateProRata(
  totalAmount: bigint,
  items: ProRataItem[],
): Map<string, bigint> {
  const allocations = new Map<string, bigint>();
  if (totalAmount <= 0n) return allocations;

  const ranked = sortItemsByKey(items.filter((item) => item.weight > 0n));
  if (ranked.length === 0) return allocations;

  const totalWeight = ranked.reduce((acc, item) => acc + item.weight, 0n);
  if (totalWeight <= 0n) return allocations;

  let allocated = 0n;
  const remainders = ranked.map((item) => {
    const numerator = totalAmount * item.weight;
    const base = numerator / totalWeight;
    const remainder = numerator % totalWeight;
    allocated += base;
    allocations.set(item.key, base);
    return { key: item.key, remainder };
  });

  let leftover = totalAmount - allocated;
  remainders.sort((a, b) => {
    if (a.remainder === b.remainder) return a.key.localeCompare(b.key);
    return a.remainder > b.remainder ? -1 : 1;
  });

  for (const item of remainders) {
    if (leftover <= 0n) break;
    allocations.set(item.key, (allocations.get(item.key) ?? 0n) + 1n);
    leftover -= 1n;
  }

  return allocations;
}

export function applyCappedRedistribution(
  totalAmount: bigint,
  items: CappedWeightItem[],
): { allocations: Map<string, bigint>; unallocatedAmount: bigint } {
  const allocations = new Map<string, bigint>();
  const normalized = sortItemsByKey(
    items
      .filter((item) => item.cap > 0n && item.weight > 0n)
      .map((item) => ({
        key: item.key,
        weight: item.weight,
        cap: item.cap,
      })),
  );

  let remainingAmount = totalAmount > 0n ? totalAmount : 0n;
  let active = normalized;

  while (remainingAmount > 0n && active.length > 0) {
    const round = allocateProRata(
      remainingAmount,
      active.map((item) => ({ key: item.key, weight: item.weight })),
    );
    if (round.size === 0) break;

    let overflow = 0n;
    const nextActive: typeof active = [];

    for (const item of active) {
      const alreadyAllocated = allocations.get(item.key) ?? 0n;
      const room = item.cap > alreadyAllocated ? item.cap - alreadyAllocated : 0n;
      const proposed = round.get(item.key) ?? 0n;
      const grant = proposed > room ? room : proposed;
      if (grant > 0n) allocations.set(item.key, alreadyAllocated + grant);
      if (proposed > grant) overflow += proposed - grant;
      const nextRoom = item.cap > (allocations.get(item.key) ?? 0n) ? item.cap - (allocations.get(item.key) ?? 0n) : 0n;
      if (nextRoom > 0n) nextActive.push(item);
    }

    if (overflow === 0n) {
      remainingAmount = 0n;
      break;
    }

    remainingAmount = overflow;
    active = nextActive;
  }

  return {
    allocations,
    unallocatedAmount: remainingAmount,
  };
}

export function computeAirdropWeightTier(
  score: bigint,
  step: bigint = AIRDROP_WEIGHT_TIER_STEP,
  maxTier = 5,
): number {
  if (score <= 0n) return 0;
  const normalizedStep = step > 0n ? step : AIRDROP_WEIGHT_TIER_STEP;
  const normalizedMaxTier = Math.max(1, Math.trunc(maxTier));
  const tier = Number((score - 1n) / normalizedStep) + 1;
  return Math.min(normalizedMaxTier, Math.max(1, tier));
}

export function computeSquadDiminishingWeight(
  volume: bigint,
  firstThreshold: bigint = SQUAD_DIMINISHING_FIRST_THRESHOLD,
  secondThreshold: bigint = SQUAD_DIMINISHING_SECOND_THRESHOLD,
): bigint {
  if (volume <= 0n) return 0n;
  const first = firstThreshold > 0n ? firstThreshold : SQUAD_DIMINISHING_FIRST_THRESHOLD;
  const second = secondThreshold > first ? secondThreshold : first * 2n;
  const firstSlice = volume > first ? first : volume;
  const remainingAfterFirst = volume > first ? volume - first : 0n;
  const secondBandSize = second - first;
  const secondSlice = remainingAfterFirst > secondBandSize ? secondBandSize : remainingAfterFirst;
  const thirdSlice = remainingAfterFirst > secondBandSize ? remainingAfterFirst - secondBandSize : 0n;

  return firstSlice + (secondSlice / 2n) + (thirdSlice / 4n);
}
