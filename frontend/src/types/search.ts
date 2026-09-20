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
  href: string;
}
