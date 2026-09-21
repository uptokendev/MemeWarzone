/**
 * The quote side of a graduated Solana pool as the token page needs it.
 *
 * The token summary carries what the indexer recorded at graduation
 * (dexQuoteMint / Symbol / Decimals / ReferenceUsd). Campaigns graduated before
 * Graduation Markets existed, and campaigns still bonding, report nothing and
 * are SOL pools.
 */
export const SOLANA_NATIVE_MINT = "So11111111111111111111111111111111111111112";

export function solanaPoolQuoteFromStats(stats) {
  const mint = String(stats?.dexQuoteMint || "").trim();
  if (!mint || mint === SOLANA_NATIVE_MINT) {
    return { mint: SOLANA_NATIVE_MINT, symbol: "SOL", decimals: 9, native: true, referenceUsd: null };
  }
  const decimals = Number(stats?.dexQuoteDecimals);
  const reference = Number(stats?.dexQuoteReferenceUsd);
  return {
    mint,
    symbol: String(stats?.dexQuoteSymbol || "").trim() || "QUOTE",
    decimals: Number.isInteger(decimals) && decimals >= 0 ? decimals : 6,
    native: false,
    referenceUsd: Number.isFinite(reference) && reference > 0 ? reference : null,
  };
}
