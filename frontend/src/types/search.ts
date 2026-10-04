export type TokenStatus = "bonding" | "graduated" | "unknown";
export type SearchResultKind = "token" | "wallet" | "draft";

export interface TokenSearchResult {
  kind: SearchResultKind;
  /** Set on drafts: a pre-launch promotion page, not a tradeable token. */
  draftSlug?: string;
  campaignAddress: string;
  tokenAddress?: string;
  name: string;
  symbol: string;
  status: TokenStatus;
  logoURI?: string;
  chainId: number;
  marketcapBnb?: string | null;
  /** Imported coins carry their DEX market cap in USD (founder, 2026-10-05). */
  marketCapUsd?: number | null;
  href: string;
}
