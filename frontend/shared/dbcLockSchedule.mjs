import {
  DBC_LOCK_CLIFF_SECONDS,
  DBC_LOCK_FREQUENCY_SECONDS,
  DBC_LOCK_PERIODS,
  DBC_LOCK_STEP_BPS,
} from "./dbcEconomics.mjs";

export function lockAmountDivisible(amount) {
  const raw = BigInt(amount);
  if (raw <= 0n) return 0n;
  return (raw / 5n) * 5n;
}

/** Five equal 20% steps. Amount must already be divisible by 5. */
export function lockScheduleFromNow(nowUnix, amountRaw) {
  const amount = lockAmountDivisible(amountRaw);
  if (amount <= 0n) {
    throw new Error("Locked buy amount must be a positive multiple of 5.");
  }
  const start = Number(nowUnix);
  if (!Number.isFinite(start) || start <= 0) {
    throw new Error("Locked buy needs a chain timestamp.");
  }
  const step = amount / 5n;
  return {
    amount,
    step,
    vestingStartTime: start,
    cliffTime: start + DBC_LOCK_CLIFF_SECONDS,
    frequency: DBC_LOCK_FREQUENCY_SECONDS,
    cliffUnlockAmount: step,
    amountPerPeriod: step,
    numberOfPeriod: DBC_LOCK_PERIODS,
    cancelMode: 0,
    updateRecipientMode: 0,
    stepBps: DBC_LOCK_STEP_BPS,
  };
}

export function lockFullyFreeUnix(cliffTime) {
  return Number(cliffTime) + DBC_LOCK_FREQUENCY_SECONDS * DBC_LOCK_PERIODS;
}

export function creatorLockBadge({
  creatorHeldRaw,
  lockedRaw,
  supplyRaw,
  fullyFreeUnix,
  nowUnix,
} = {}) {
  const supply = BigInt(supplyRaw || 0);
  const held = BigInt(creatorHeldRaw || 0);
  const locked = BigInt(lockedRaw || 0);
  const heldPct = supply > 0n ? Number((held * 10000n) / supply) / 100 : 0;
  const lockedPct = supply > 0n ? Number((locked * 10000n) / supply) / 100 : 0;
  const now = Number(nowUnix ?? Math.floor(Date.now() / 1000));
  const until = Number(fullyFreeUnix || 0);
  if (!(until > now) || locked <= 0n) {
    return `Creator holds ${heldPct.toFixed(2)}% of supply.`;
  }
  const when = new Date(until * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `Creator holds ${heldPct.toFixed(2)}% of supply, ${lockedPct.toFixed(2)}% locked until ${when}.`;
}
