/**
 * Gen-8 creator escrow, the gen-7 schedule (MwzCreatorEscrow, proven on the chain test:
 * one buy pays escrowed/5 after 30 days). Each buy releases 20% at +30 days, then 20%
 * every 7 days, five tranches. Vesting is the sum of those steps, divided by 5, rounded down.
 * The constants match shared/dbcEconomics.mjs (cliff, 7 day step, 20%).
 */

export const GEN8_ESCROW_CLIFF_SECONDS = 30 * 24 * 60 * 60;
export const GEN8_ESCROW_STEP_SECONDS = 7 * 24 * 60 * 60;
export const GEN8_ESCROW_TRANCHES = 5;

export const GEN8_CREATOR_BUY_ESCROW_COPY =
  "These coins go to escrow. 20% unlocks after 30 days, then 20% every 7 days.";

function cumAt(buys, key) {
  let total = 0n;
  for (const buy of buys) {
    if (Number(buy.at) <= key) total += BigInt(buy.amount);
  }
  return total;
}

/** Tokens released by unix time `now`, from buys `{ at, amount }`. */
export function gen8EscrowVested(buys, now) {
  const t = Number(now);
  if (!Number.isFinite(t)) return 0n;
  let sum = 0n;
  for (let k = 0; k < GEN8_ESCROW_TRANCHES; k += 1) {
    const offset = GEN8_ESCROW_CLIFF_SECONDS + k * GEN8_ESCROW_STEP_SECONDS;
    if (t < offset) break;
    sum += cumAt(buys || [], t - offset);
  }
  return sum / BigInt(GEN8_ESCROW_TRANCHES);
}

/**
 * Locked coins and the next tranche. `claimed` and `claimable` are the contract's numbers
 * when the caller has them; the next date comes from the buys.
 */
export function gen8EscrowUnlockLabel(at) {
  const d = new Date(Number(at) * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

export function gen8EscrowPosition({ buys, claimed = 0n, claimable = null, now, knownTotal = null }) {
  const list = Array.isArray(buys) ? buys : [];
  const fromBuys = list.reduce((sum, buy) => sum + BigInt(buy.amount), 0n);
  const total = knownTotal == null ? fromBuys : BigInt(knownTotal);
  const vested = gen8EscrowVested(list, now);
  const claimedBig = BigInt(claimed);
  const claimableBig = claimable == null ? (vested > claimedBig ? vested - claimedBig : 0n) : BigInt(claimable);
  const released = claimedBig + claimableBig;
  const locked = total > released ? total - released : 0n;
  let next = null;
  const times = [];
  for (const buy of list) {
    const at = Number(buy.at);
    if (!Number.isFinite(at)) continue;
    for (let k = 0; k < GEN8_ESCROW_TRANCHES; k += 1) {
      const unlockAt = at + GEN8_ESCROW_CLIFF_SECONDS + k * GEN8_ESCROW_STEP_SECONDS;
      if (unlockAt > Number(now)) times.push(unlockAt);
    }
  }
  times.sort((a, b) => a - b);
  for (const at of times) {
    const then = gen8EscrowVested(list, at);
    if (then > vested) {
      next = { at, amount: then - vested };
      break;
    }
  }
  return { total, vested, claimed: claimedBig, claimable: claimableBig, locked, next };
}
