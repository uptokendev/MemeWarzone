export function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function weiToNative(raw, decimals = 18) {
  try {
    const s = String(raw ?? "0");
    if (!s || s === "0") return 0;
    const neg = s.startsWith("-");
    const digits = neg ? s.slice(1) : s;
    if (!/^\d+$/.test(digits)) return 0;
    const places = Math.max(0, Number(decimals) || 18);
    const pad = digits.padStart(places + 1, "0");
    const whole = pad.slice(0, -places) || "0";
    const frac = pad.slice(-places);
    const n = Number(`${whole}.${frac}`);
    return Number.isFinite(n) ? (neg ? -n : n) : 0;
  } catch {
    return 0;
  }
}

/**
 * Ranking vs accounting:
 * - referredVolumeBnb / referredVolumeSol / epochEarnedBnb / epochEarnedSol
 *   are native claim-side amounts. Never merge them.
 * - referredVolumeUsd / epochEarnedUsd are display/compare totals.
 * - normalizedScoreVolume / normalizedScoreEarnings are ranking inputs only
 *   so existing 0.05 / 1.0 weights keep their scale. They are not balances.
 */
export function combineReferredUsd({
  referredVolumeBnb = 0,
  referredVolumeSol = 0,
  epochEarnedBnb = 0,
  epochEarnedSol = 0,
  bnbUsd = 0,
  solUsd = 0,
}) {
  const bnbPrice = toNumber(bnbUsd);
  const solPrice = toNumber(solUsd);
  const volumeBnb = toNumber(referredVolumeBnb);
  const volumeSol = toNumber(referredVolumeSol);
  const earnedBnb = toNumber(epochEarnedBnb);
  const earnedSol = toNumber(epochEarnedSol);
  const bnbVolumeUsd = bnbPrice > 0 ? volumeBnb * bnbPrice : 0;
  const solVolumeUsd = solPrice > 0 ? volumeSol * solPrice : 0;
  const bnbEarnedUsd = bnbPrice > 0 ? earnedBnb * bnbPrice : 0;
  const solEarnedUsd = solPrice > 0 ? earnedSol * solPrice : 0;
  const referredVolumeUsd = bnbVolumeUsd + solVolumeUsd;
  const epochEarnedUsd = bnbEarnedUsd + solEarnedUsd;
  return {
    referredVolumeUsd,
    epochEarnedUsd,
    normalizedScoreVolume: bnbPrice > 0 ? referredVolumeUsd / bnbPrice : volumeBnb,
    normalizedScoreEarnings: bnbPrice > 0 ? epochEarnedUsd / bnbPrice : earnedBnb,
  };
}

/** Canonical squad roles. `both` counts as creator AND trader. Never infer from campaigns. */
export function squadRoleCounts(roles) {
  let creators = 0;
  let traders = 0;
  const list = Array.isArray(roles) ? roles : [];
  for (const role of list) {
    const value = String(role || "").trim().toLowerCase();
    if (value === "creator" || value === "both") creators += 1;
    if (value === "trader" || value === "both") traders += 1;
  }
  return { squad: list.length, creators, traders };
}

export function scoreUniversalRecruiter(input, weights) {
  const w = weights || {
    linkedWallets: 1,
    linkedCreators: 3,
    linkedTraders: 2,
    routedVolumeBnb: 0.05,
    totalEarnedBnb: 1,
  };
  const linkedWalletCount = toNumber(input.linkedWalletCount);
  const linkedCreatorsCount = toNumber(input.linkedCreatorsCount);
  const linkedTradersCount = toNumber(input.linkedTradersCount);
  const money = combineReferredUsd(input);
  const weightedScore =
    linkedWalletCount * w.linkedWallets +
    linkedCreatorsCount * w.linkedCreators +
    linkedTradersCount * w.linkedTraders +
    money.normalizedScoreVolume * w.routedVolumeBnb +
    money.normalizedScoreEarnings * w.totalEarnedBnb;
  return { ...money, weightedScore };
}
