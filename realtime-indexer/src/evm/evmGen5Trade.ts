/**
 * Pure maths for generation-5 campaign trades (docs/evm-launch/spec/C2-C4-trading.md), mirrored
 * exactly from contracts/LaunchCampaign.sol:
 *
 * - C2 anti-sniper fee: `currentTradeFeeBps()` is 5000 at launchAt, falling linearly to the base fee
 *   (protocolFeeBps, 200) at launchAt + 60 s, flat after. The events carry no fee, so the fee actually
 *   charged is derived from the event amount, the block time and the campaign's launchAt:
 *     buy:  TokensPurchased.cost = costNoFee + floor(costNoFee * bps / 1e4)
 *     sell: TokensSold.payout    = gross     - floor(gross * bps / 1e4)
 * - C3 creator first buy: flat base fee, never the anti-sniper fee; CreatorFirstBuy carries the fee.
 * - C4 creator escrow: every buy whose actor is the creator (other than the first buy) is escrowed.
 * - D13: no creator buy counts for the leagues (first buy and escrow buys).
 */

export const MAX_BPS = 10_000n;
export const ANTI_SNIPER_START_BPS = 5_000n;
export const ANTI_SNIPER_WINDOW_SECONDS = 60n;
export const ESCROW_CLIFF_SECONDS = 30n * 86_400n;
export const ESCROW_STEP_SECONDS = 7n * 86_400n;
export const ESCROW_TRANCHES = 5n;

/**
 * LaunchCampaign.currentTradeFeeBps() at block time `t` (seconds). `startBps` is the anti-sniper start:
 * 5000 on gen-6 (the default), 9000 on gen-7 (LaunchCampaignGen7, same formula).
 */
export function gen5TradeFeeBps(baseBps: bigint, launchAt: bigint, t: bigint, startBps: bigint = ANTI_SNIPER_START_BPS): bigint {
  const end = launchAt + ANTI_SNIPER_WINDOW_SECONDS;
  if (t >= end) return baseBps;
  let left = end - t;
  if (left > ANTI_SNIPER_WINDOW_SECONDS) left = ANTI_SNIPER_WINDOW_SECONDS;
  return baseBps + ((startBps - baseBps) * left) / ANTI_SNIPER_WINDOW_SECONDS;
}

function feeOf(amount: bigint, bps: bigint): bigint {
  return (amount * bps) / MAX_BPS;
}

/**
 * Invert `total = c + floor(c * bps / 1e4)`. The map is strictly increasing in c, so at most one c
 * matches. Returns null when none does (the amount did not come from this fee).
 */
export function invertBuyTotal(total: bigint, bps: bigint): { costNoFee: bigint; fee: bigint } | null {
  if (total < 0n) return null;
  const guess = (total * MAX_BPS) / (MAX_BPS + bps);
  for (const delta of [0n, 1n, -1n, 2n, -2n, 3n, -3n]) {
    const c = guess + delta;
    if (c < 0n) continue;
    if (c + feeOf(c, bps) === total) return { costNoFee: c, fee: total - c };
  }
  return null;
}

/**
 * Invert `payout = g - floor(g * bps / 1e4)`. The map is non-decreasing and can repeat one payout for
 * two consecutive g (where the floor steps), so the answer may be 1 wei ambiguous; the smallest g is
 * returned (fee off by at most 1 wei). Returns null when no g matches.
 */
export function invertSellPayout(payout: bigint, bps: bigint): { gross: bigint; fee: bigint } | null {
  if (payout < 0n) return null;
  if (bps >= MAX_BPS) return null;
  const guess = (payout * MAX_BPS) / (MAX_BPS - bps);
  let best: bigint | null = null;
  for (const delta of [-3n, -2n, -1n, 0n, 1n, 2n, 3n]) {
    const g = guess + delta;
    if (g < 0n) continue;
    if (g - feeOf(g, bps) === payout && (best === null || g < best)) best = g;
  }
  return best === null ? null : { gross: best, fee: best - payout };
}

export type Gen5TradeAnnotation = {
  /** Fee actually charged, native wei. null when it could not be derived. */
  feeRaw: bigint | null;
  feeBps: number | null;
  /** Buy: cost without fee (what the raise grew by). Sell: gross before fee. */
  grossRaw: bigint | null;
  creatorBuyKind: "first_buy" | "escrow" | null;
  /** D13: creator buys never count for leagues. */
  leagueExcluded: boolean;
};

export type Gen5TradeInput = {
  side: "buy" | "sell";
  /** TokensPurchased.cost (buy, fee included) or TokensSold.payout (sell, fee removed). */
  amountRaw: bigint;
  blockTimeSec: bigint;
  launchAt: bigint | null;
  baseFeeBps: bigint | null;
  wallet: string;
  creator: string | null;
  /** Present when the same transaction emitted CreatorFirstBuy (C3): its exact fee. */
  firstBuy?: { costNoFee: bigint; fee: bigint } | null;
  /** Anti-sniper start fee; absent = gen-6's 5000. Gen-7 campaigns pass 9000. */
  antiSniperStartBps?: bigint;
};

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

export function annotateGen5Trade(input: Gen5TradeInput): Gen5TradeAnnotation {
  const isCreator = sameAddress(input.wallet, input.creator);
  if (input.side === "buy" && input.firstBuy) {
    return {
      feeRaw: input.firstBuy.fee,
      feeBps: input.baseFeeBps !== null ? Number(input.baseFeeBps) : null,
      grossRaw: input.firstBuy.costNoFee,
      creatorBuyKind: "first_buy",
      leagueExcluded: true,
    };
  }
  const creatorBuyKind = input.side === "buy" && isCreator ? "escrow" : null;
  const leagueExcluded = creatorBuyKind !== null;
  if (input.launchAt === null || input.baseFeeBps === null) {
    return { feeRaw: null, feeBps: null, grossRaw: null, creatorBuyKind, leagueExcluded };
  }
  const bps = gen5TradeFeeBps(input.baseFeeBps, input.launchAt, input.blockTimeSec, input.antiSniperStartBps ?? ANTI_SNIPER_START_BPS);
  if (input.side === "buy") {
    const inv = invertBuyTotal(input.amountRaw, bps);
    return {
      feeRaw: inv ? inv.fee : null,
      feeBps: Number(bps),
      grossRaw: inv ? inv.costNoFee : null,
      creatorBuyKind,
      leagueExcluded,
    };
  }
  const inv = invertSellPayout(input.amountRaw, bps);
  return {
    feeRaw: inv ? inv.fee : null,
    feeBps: Number(bps),
    grossRaw: inv ? inv.gross : null,
    creatorBuyKind,
    leagueExcluded,
  };
}

/**
 * LaunchCampaign.creatorEscrowVested(t): every escrowed buy of `a` at `s` releases a/5 at
 * s + 30d + 7d*k (k = 0..4); the sum over buys is floored once, like the contract's checkpoint maths.
 */
export function creatorEscrowVested(entries: Array<{ amount: bigint; timestamp: bigint }>, t: bigint): bigint {
  let vested = 0n;
  for (let k = 0n; k < ESCROW_TRANCHES; k += 1n) {
    const offset = ESCROW_CLIFF_SECONDS + k * ESCROW_STEP_SECONDS;
    if (t < offset) break;
    const key = t - offset;
    for (const entry of entries) {
      if (entry.timestamp <= key) vested += entry.amount;
    }
  }
  return vested / ESCROW_TRANCHES;
}

/** Next time (seconds) at which more escrow vests, or null when everything is released. */
export function creatorEscrowNextRelease(entries: Array<{ amount: bigint; timestamp: bigint }>, t: bigint): bigint | null {
  let next: bigint | null = null;
  for (const entry of entries) {
    for (let k = 0n; k < ESCROW_TRANCHES; k += 1n) {
      const at = entry.timestamp + ESCROW_CLIFF_SECONDS + k * ESCROW_STEP_SECONDS;
      if (at > t && (next === null || at < next)) next = at;
    }
  }
  return next;
}
