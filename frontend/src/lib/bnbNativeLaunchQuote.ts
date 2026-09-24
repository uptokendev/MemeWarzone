import type { GraduationQuoteAsset } from "@/lib/graduationQuoteCatalog";
import { evmNativeLaunchQuote as evmNativeLaunchQuoteMjs, isEvmNativeLaunchQuote as isEvmNativeLaunchQuoteMjs } from "@/lib/graduationMarketPresentation.mjs";

/**
 * Launch-day native market choice for the EVM chains (BNB 56, Robinhood 4663
 * and their testnets). The rule lives in graduationMarketPresentation.mjs so
 * the node tests exercise it; this file only types it for the TSX callers.
 *
 * Native BNB / native ETH is deliberately not a generic Quote Asset Catalog
 * deployment: selecting it keeps the legacy/native createCampaignAuthorized
 * path and never injects a quote id.
 */
export function evmNativeLaunchQuote(chainId: number): GraduationQuoteAsset | null {
  return evmNativeLaunchQuoteMjs(chainId) as GraduationQuoteAsset | null;
}

export function isEvmNativeLaunchQuote(asset: GraduationQuoteAsset | null | undefined): boolean {
  return isEvmNativeLaunchQuoteMjs(asset);
}

/** @deprecated chain-56-only names kept for callers that still use them; same rule. */
export const bnbNativeLaunchQuote = evmNativeLaunchQuote;
export const isBnbNativeLaunchQuote = isEvmNativeLaunchQuote;
