/**
 * Pure, side-effect-free portfolio metric calculation functions (Node.js version).
 *
 * This is the **exact server-side mirror** of the frontend implementation in
 * src/lib/profile/portfolioCalculations.ts (Phase 2).
 *
 * ⚠️ CRITICAL: Keep behavior and math 100% in sync with the TypeScript source.
 * Any modification here must be mirrored there (and vice-versa).
 *
 * All functions are pure (no React, no fetch, no side effects).
 * Used by the /api/profile/portfolio cached endpoint.
 */

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parses a native balance string such as "1.2345 BNB" or "0.0000 BNB" into a number.
 * Returns 0 for invalid/empty input.
 */
export function parseNativeBalanceBnb(nativeBalance) {
  if (!nativeBalance) return 0;
  const cleaned = String(nativeBalance).replace(/[^0-9.]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Calculates approximate USD value for a single token holding.
 *
 * Uses marketCapBnb (from DB stats) as the valuation anchor + BNB/USD price.
 * Assumes a standard ~1B supply model common to these bonding-curve tokens.
 *
 * Returns 0 for invalid/zero inputs (graceful degradation).
 */
export function calculateHoldingValueUsd(balanceFormatted, marketCapBnb, bnbUsd) {
  const bal = Number.parseFloat(balanceFormatted || "0");
  if (!Number.isFinite(bal) || bal <= 0) return 0;
  if (!bnbUsd || bnbUsd <= 0) return 0;

  const mcap = marketCapBnb && Number.isFinite(marketCapBnb) && marketCapBnb > 0
    ? marketCapBnb
    : 0;

  if (mcap <= 0) return 0;

  // Standard approximation for these launchpad tokens (keep in sync with TS version)
  const estPriceBnbPerWholeToken = mcap / 1_000_000_000;
  const valueUsd = bal * estPriceBnbPerWholeToken * bnbUsd;

  return Number.isFinite(valueUsd) && valueUsd > 0 ? valueUsd : 0;
}

/**
 * Given an array of holdings that already have valueUsd computed,
 * returns the single top holding with its percentage of the total portfolio value.
 * Returns null if no positive-value holdings.
 */
export function selectTopHolding(holdings) {
  if (!Array.isArray(holdings) || holdings.length === 0) return null;

  let best = { ticker: "", valueUsd: 0 };
  let totalPositive = 0;

  for (const h of holdings) {
    const v = Number.isFinite(h.valueUsd) ? h.valueUsd : 0;
    if (v > 0) totalPositive += v;
    if (v > best.valueUsd) {
      best = { ticker: h.ticker || "?", valueUsd: v };
    }
  }

  if (best.valueUsd <= 0 || totalPositive <= 0) return null;

  const percent = (best.valueUsd / totalPositive) * 100;

  return {
    ticker: best.ticker,
    percentOfPortfolio: Math.max(0, Math.min(100, Math.round(percent * 10) / 10)),
    valueUsd: best.valueUsd,
  };
}

/**
 * Derives the four portfolio metrics.
 * This is the single source of truth for the four cards.
 */
export function derivePortfolioMetrics(params) {
  const { nativeBnb = 0, tokenHoldingsWithValues = [], bnbUsd = 0, createdAt, holdingsCount } = params || {};

  const nativeUsd = (Number.isFinite(nativeBnb) ? nativeBnb : 0) *
    (Number.isFinite(bnbUsd) && bnbUsd > 0 ? bnbUsd : 0);

  let tokenTotalUsd = 0;
  const positiveHoldings = [];

  for (const h of tokenHoldingsWithValues) {
    const v = Number.isFinite(h.valueUsd) ? h.valueUsd : 0;
    if (v > 0) {
      tokenTotalUsd += v;
      positiveHoldings.push({ ticker: h.ticker || "?", valueUsd: v });
    }
  }

  const totalValueUsd = nativeUsd + tokenTotalUsd;
  const safeTotal = totalValueUsd > 0 ? totalValueUsd : 0;

  let topHolding = selectTopHolding(positiveHoldings);

  if (topHolding && safeTotal > 0) {
    const overallPercent = (topHolding.valueUsd / safeTotal) * 100;
    topHolding = {
      ...topHolding,
      percentOfPortfolio: Math.max(0, Math.min(100, Math.round(overallPercent * 10) / 10)),
    };
  }

  const coinsCount = Number.isFinite(Number(holdingsCount)) && Number(holdingsCount) >= 0
    ? Math.trunc(Number(holdingsCount))
    : positiveHoldings.length;
  const walletAge = formatWalletAge(createdAt);

  return {
    totalValueUsd: safeTotal > 0 ? safeTotal : null,
    topHolding,
    coinsCount,
    walletAge,
  };
}

/**
 * Human-readable wallet age string from the profile created_at timestamp (ISO string).
 * Adapted from existing formatTimeAgo patterns (keep in sync).
 */
export function formatWalletAge(createdAt) {
  if (!createdAt) return "new";

  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return "new";

  const now = Date.now();
  const diffMs = Math.max(0, now - created.getTime());
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 3600) return "new";

  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffDay < 1) return `${diffHr}h`;
  if (diffDay < 30) return `${diffDay}d`;
  if (diffDay < 365) {
    const mo = Math.floor(diffDay / 30);
    return `${mo}mo`;
  }
  const yr = Math.floor(diffDay / 365);
  return `${yr}y`;
}
