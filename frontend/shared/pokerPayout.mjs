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
 * Mirrors realtime-indexer/src/rewards/pokerPayout.ts (parity test pins them): the league page shows
 * exactly what the settlement job pays.
 */

export const POKER_PAID_FIELD_BPS = 1_500;
export const POKER_ALPHA = 0.72;
export const POKER_MAX_PAID_PLACES = 255;
const WEIGHT_SCALE = 1_000_000_000_000;

export function pokerMinWinners(period) {
  return String(period) === "weekly" ? 3 : 5;
}

export function pokerPaidPlaces(entrants, period) {
  const field = Math.max(0, Math.floor(Number(entrants) || 0));
  if (field === 0) return 0;
  const byField = Math.floor((field * POKER_PAID_FIELD_BPS) / 10_000);
  return Math.min(field, POKER_MAX_PAID_PLACES, Math.max(pokerMinWinners(period), byField));
}

export function pokerWeights(places) {
  return Array.from({ length: Math.max(0, places) }, (_, index) => BigInt(Math.round(WEIGHT_SCALE / (index + 1) ** POKER_ALPHA)));
}

/** Exact split of `pot` over `places` ranks; sums to `pot` exactly. */
export function pokerSplitRaw(pot, places) {
  if (places <= 0 || pot <= 0n) return [];
  const weights = pokerWeights(places);
  const total = weights.reduce((sum, w) => sum + w, 0n);
  const shares = weights.map((w) => (pot * w) / total);
  const paid = shares.reduce((sum, s) => sum + s, 0n);
  shares[0] += pot - paid;
  return shares;
}

/** Convenience: paid places for this field and their exact amounts. */
export function pokerPayoutForField(pot, entrants, period) {
  return pokerSplitRaw(pot, pokerPaidPlaces(entrants, period));
}
