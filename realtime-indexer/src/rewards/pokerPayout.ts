/**
 * Poker-style league payout (founder, 2026-09-26): "if 100 participants are in and only 1 gets paid
 * we have got a problem". One rule for every league -- pre-grad weekly / monthly, Major War League
 * monthly and the quarterly finals -- on every chain:
 *
 *   paid places = 15% of the qualified field, at least 3 (weekly) or 5 (every other round),
 *                 never more than the field itself, at most 255 (the claim rails' u8 rank)
 *   weights     = 1 / rank^0.72, fixed-point, so every place pays less than the one above
 *   amounts     = exact integer shares of the pot; the rounding remainder goes to rank 1, so the
 *                 whole pot is always paid out and nothing is stranded
 *
 * Mirrored byte-for-byte in frontend/shared/pokerPayout.mjs (parity test pins them); the league page
 * shows exactly what this pays.
 */

export const POKER_PAID_FIELD_BPS = 1_500;
export const POKER_ALPHA = 0.72;
export const POKER_MAX_PAID_PLACES = 255;
const WEIGHT_SCALE = 1_000_000_000_000;

export type PokerPeriod = "weekly" | "monthly" | "mwl_monthly" | "quarterly";

export function pokerMinWinners(period: PokerPeriod | string): number {
  return String(period) === "weekly" ? 3 : 5;
}

export function pokerPaidPlaces(entrants: number, period: PokerPeriod | string): number {
  const field = Math.max(0, Math.floor(Number(entrants) || 0));
  if (field === 0) return 0;
  const byField = Math.floor((field * POKER_PAID_FIELD_BPS) / 10_000);
  return Math.min(field, POKER_MAX_PAID_PLACES, Math.max(pokerMinWinners(period), byField));
}

export function pokerWeights(places: number): bigint[] {
  return Array.from({ length: Math.max(0, places) }, (_, index) => BigInt(Math.round(WEIGHT_SCALE / (index + 1) ** POKER_ALPHA)));
}

/** Exact split of `pot` over `places` ranks; sums to `pot` exactly. */
export function pokerSplitRaw(pot: bigint, places: number): bigint[] {
  if (places <= 0 || pot <= 0n) return [];
  const weights = pokerWeights(places);
  const total = weights.reduce((sum, w) => sum + w, 0n);
  const shares = weights.map((w) => (pot * w) / total);
  const paid = shares.reduce((sum, s) => sum + s, 0n);
  shares[0] += pot - paid;
  return shares;
}

/** Convenience: paid places for this field and their exact amounts. */
export function pokerPayoutForField(pot: bigint, entrants: number, period: PokerPeriod | string): bigint[] {
  return pokerSplitRaw(pot, pokerPaidPlaces(entrants, period));
}

/**
 * Solana minimum payout (founder, 2026-09-28, option B). Every Solana claim creates a receipt the
 * winner pays ~0.0013 SOL of rent for, so a prize below this is not paid on its own: a league pays
 * fewer places (the whole pot still goes out), a pot too small for even one place rolls over, and
 * recruiter / airdrop amounts wait until they are worth claiming. Solana (101) only; env
 * SOLANA_MIN_PAYOUT_LAMPORTS, default 0.005 SOL.
 */
export const SOLANA_MIN_PAYOUT_LAMPORTS_DEFAULT = 5_000_000n;

export function solanaMinPayoutLamports(env: Record<string, string | undefined> = process.env): bigint {
  const raw = String(env.SOLANA_MIN_PAYOUT_LAMPORTS ?? "").trim();
  if (/^\d+$/.test(raw)) return BigInt(raw);
  return SOLANA_MIN_PAYOUT_LAMPORTS_DEFAULT;
}

/** Most places (<= places) whose smallest share is at least minRaw; 0 when even one place is below it. */
export function pokerPlacesAboveMinimum(pot: bigint, places: number, minRaw: bigint): number {
  for (let k = Math.max(0, places); k >= 1; k -= 1) {
    const shares = pokerSplitRaw(pot, k);
    if (shares[shares.length - 1] >= minRaw) return k;
  }
  return 0;
}
