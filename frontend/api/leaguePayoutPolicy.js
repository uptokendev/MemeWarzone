export const DEFAULT_PAID_FIELD_PCT = 0.15;
export const FUTURE_PAID_FIELD_PCT = 0.2;
export const PAYOUT_ALPHA = 0.72;
export const MONTHLY_PLAYER_PRIZE_CAP_USD = 1_500_000;

export function getPayoutPolicy(period = "weekly", paidFieldPct = DEFAULT_PAID_FIELD_PCT) {
  const normalizedPeriod = String(period || "weekly").toLowerCase() === "monthly" ? "monthly" : "weekly";
  return {
    minWinners: normalizedPeriod === "weekly" ? 3 : 5,
    paidFieldPct,
    alpha: PAYOUT_ALPHA,
    monthlyPlayerPrizeCapUsd: MONTHLY_PLAYER_PRIZE_CAP_USD,
  };
}

export function calculatePaidPlaces(qualifiedEntrants, policy) {
  const entrants = Math.max(0, Math.floor(Number(qualifiedEntrants) || 0));
  if (entrants <= 0) return 0;
  // Poker rule (shared/pokerPayout.mjs): never more places than entrants, at most 255 (u8 claim rank).
  return Math.min(entrants, 255, Math.max(policy.minWinners, Math.floor(entrants * policy.paidFieldPct)));
}

export function calculatePayoutCurve(qualifiedEntrants, prizePoolUsd, policy) {
  const paidPlaces = calculatePaidPlaces(qualifiedEntrants, policy);
  const safePool = Math.max(0, Number.isFinite(Number(prizePoolUsd)) ? Number(prizePoolUsd) : 0);
  if (paidPlaces <= 0 || safePool <= 0) return [];

  const weights = Array.from({ length: paidPlaces }, (_, index) => 1 / (index + 1) ** policy.alpha);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;

  return weights.map((weight, index) => ({
    rank: index + 1,
    percentage: weight / totalWeight,
    payoutUsd: safePool * (weight / totalWeight),
  }));
}

export function getCapMeta(period, generatedUsd, policy) {
  const normalizedPeriod = String(period || "weekly").toLowerCase() === "monthly" ? "monthly" : "weekly";
  const rawUsd = Math.max(0, Number(generatedUsd) || 0);
  const monthlyCap = Number(policy?.monthlyPlayerPrizeCapUsd || MONTHLY_PLAYER_PRIZE_CAP_USD);
  const capped = normalizedPeriod === "monthly";
  const playerPrizePoolUsd = capped ? Math.min(rawUsd, monthlyCap) : rawUsd;
  const charityReserveUsd = capped ? Math.max(0, rawUsd - monthlyCap) : 0;

  return {
    capApplies: capped,
    capReached: capped && rawUsd >= monthlyCap,
    monthlyPlayerPrizeCapUsd: monthlyCap,
    generatedUsd: rawUsd,
    playerPrizePoolUsd,
    charityReserveUsd,
  };
}
