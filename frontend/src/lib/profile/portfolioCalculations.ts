/**
 * Pure, side-effect-free portfolio metric calculation functions.
 *
 * These are extracted/adapted from existing balance logic, warRoomMetrics.ts
 * formatting patterns, and FeaturedCampaigns-style derivations.
 *
 * The goal is maximum reuse:
 * - Client-side (Command Center, freshest data via useProfileBalances + on-chain)
 * - Future backend mirror at api/lib/portfolioCalculations.js (for public profile cached endpoint)
 *
 * ⚠️ CRITICAL: Keep behavior and math 100% in sync with the backend JS version.
 * Any modification here must be mirrored (and vice-versa). Unit-testable in isolation.
 *
 * All functions are pure (no React, no fetch, no globals beyond Math/Date for formatting).
 */

export type PortfolioMetrics = {
  totalValueUsd: number | null;
  topHolding: {
    ticker: string;
    percentOfPortfolio: number;
    valueUsd: number;
  } | null;
  coinsCount: number;
  walletAge: string;
  /** Formatted "since MMM YYYY" based on actual on-chain first activity */
  walletAgeSince?: string;
};

/**
 * Parses a native balance string such as "1.2345 BNB" or "0.0000 BNB" into a number.
 * Returns 0 for invalid/empty input.
 */
export function parseNativeBalanceBnb(nativeBalance: string): number {
  if (!nativeBalance) return 0;
  const cleaned = String(nativeBalance).replace(/[^0-9.]/g, "");
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Calculates approximate USD value for a single token holding.
 *
 * Uses marketCapBnb (from CampaignSummary.stats) as the valuation anchor
 * + BNB/USD price. Assumes a standard ~1B supply model common to these
 * bonding-curve tokens for display purposes (sufficient for portfolio overview).
 *
 * Returns 0 for invalid/zero inputs (graceful degradation).
 */
export function calculateHoldingValueUsd(
  balanceFormatted: string,
  marketCapBnb: number | undefined,
  bnbUsd: number
): number {
  const bal = Number.parseFloat(balanceFormatted || "0");
  if (!Number.isFinite(bal) || bal <= 0) return 0;
  if (!bnbUsd || bnbUsd <= 0) return 0;

  const mcap = marketCapBnb && Number.isFinite(marketCapBnb) && marketCapBnb > 0
    ? marketCapBnb
    : 0;

  if (mcap <= 0) return 0;

  // Standard approximation for these launchpad tokens
  const estPriceBnbPerWholeToken = mcap / 1_000_000_000;
  const valueUsd = bal * estPriceBnbPerWholeToken * bnbUsd;

  return Number.isFinite(valueUsd) && valueUsd > 0 ? valueUsd : 0;
}

/**
 * Given an array of holdings that already have valueUsd computed,
 * returns the single top holding with its percentage of the total portfolio value.
 * Returns null if no positive-value holdings.
 */
export function selectTopHolding(
  holdings: Array<{ ticker: string; valueUsd: number }>
): { ticker: string; percentOfPortfolio: number; valueUsd: number } | null {
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
    percentOfPortfolio: Math.max(0, Math.min(100, Math.round(percent * 10) / 10)), // 1 decimal
    valueUsd: best.valueUsd,
  };
}

/**
 * Derives the four portfolio metrics from native BNB, token holdings (pre-valued),
 * current BNB price, and the profile's createdAt (from Phase 1 user_profiles.created_at).
 *
 * This is the single source of truth for the four cards (TOTAL VALUE, TOP HOLDING, COINS, WALLET AGE).
 */
export function derivePortfolioMetrics(params: {
  nativeBnb: number;
  tokenHoldingsWithValues: Array<{ ticker: string; valueUsd: number }>;
  bnbUsd: number;
  firstActivityTimestamp?: number | null; // preferred: on-chain first activity
}): PortfolioMetrics {
  const { nativeBnb = 0, tokenHoldingsWithValues = [], bnbUsd = 0, firstActivityTimestamp } = params;

  // Native contribution
  const nativeUsd = (Number.isFinite(nativeBnb) ? nativeBnb : 0) * (Number.isFinite(bnbUsd) && bnbUsd > 0 ? bnbUsd : 0);

  // Sum token values
  let tokenTotalUsd = 0;
  const positiveHoldings: Array<{ ticker: string; valueUsd: number }> = [];

  for (const h of tokenHoldingsWithValues) {
    const v = Number.isFinite(h.valueUsd) ? h.valueUsd : 0;
    if (v > 0) {
      tokenTotalUsd += v;
      positiveHoldings.push({ ticker: h.ticker || "?", valueUsd: v });
    }
  }

  const totalValueUsd = nativeUsd + tokenTotalUsd;
  const safeTotal = totalValueUsd > 0 ? totalValueUsd : 0;

  const topHolding = selectTopHolding(positiveHoldings);

  let finalTop = topHolding;
  if (topHolding && safeTotal > 0) {
    const overallPercent = (topHolding.valueUsd / safeTotal) * 100;
    finalTop = {
      ...topHolding,
      percentOfPortfolio: Math.max(0, Math.min(100, Math.round(overallPercent * 10) / 10)),
    };
  }

  const coinsCount = positiveHoldings.length;

  const walletAge = formatWalletAge(firstActivityTimestamp);
  const walletAgeSince = formatWalletAgeSince(firstActivityTimestamp);

  return {
    totalValueUsd: safeTotal > 0 ? safeTotal : null,
    topHolding: finalTop,
    coinsCount,
    walletAge,
    walletAgeSince,
  };
}

/**
 * Human-readable wallet age string (e.g. "3mo", "1y", "new").
 */
export function formatWalletAge(firstActivityTimestamp?: number | null): string {
  if (!firstActivityTimestamp) return "new";

  const now = Date.now();
  const diffMs = Math.max(0, now - firstActivityTimestamp * 1000);
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

/**
 * Returns a nice "MMM YYYY" string for display (e.g. "Apr 2026").
 * Used as the sub-text under Wallet Age.
 */
export function formatWalletAgeSince(firstActivityTimestamp?: number | null): string | undefined {
  if (!firstActivityTimestamp) return undefined;
  const date = new Date(firstActivityTimestamp * 1000);
  return date.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}
