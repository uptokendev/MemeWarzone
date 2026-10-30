/**
 * Chain id for /api/token/:id/summary. Robinhood 4663 and 46630 must stay themselves.
 * Falling through to 56 asks the BNB book and the header never sees the real row.
 * DogeOS 6281971 likewise asks its own book.
 * Unknown ids still fall back to 56. A Solana address with no chain id stays 101.
 */
const SUPPORTED = new Set([56, 97, 101, 4663, 46630, 6281971]);

export type TokenStatsChainId = 56 | 97 | 101 | 4663 | 46630 | 6281971;

export function tokenStatsChainId(chainId?: number | null, campaignAddress?: string | null): TokenStatsChainId {
  const n = Number(chainId ?? 56);
  if (SUPPORTED.has(n)) return n as TokenStatsChainId;
  const addr = String(campaignAddress || "");
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) && !addr.startsWith("0x")) return 101;
  return 56;
}
