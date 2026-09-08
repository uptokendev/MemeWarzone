import type { GraduationQuoteAsset } from "@/lib/graduationQuoteCatalog";
import { nativeDefaultQuoteAsset } from "@/lib/graduationMarketPresentation.mjs";

/**
 * Launch-day BNB native market choice.
 *
 * Native BNB is deliberately not a generic Quote Asset Catalog deployment: selecting it must
 * keep the legacy/native createCampaignAuthorized path and must never inject a BNB BASIC quote id.
 */
export function bnbNativeLaunchQuote(chainId: number): GraduationQuoteAsset | null {
  if (Number(chainId) !== 56) return null;
  return nativeDefaultQuoteAsset(56) as GraduationQuoteAsset;
}

export function isBnbNativeLaunchQuote(asset: GraduationQuoteAsset | null | undefined): boolean {
  return Boolean(
    asset?.presentationDefault === true &&
      Number(asset.chainId) === 56 &&
      String(asset.identityKind || "").toUpperCase() === "NATIVE" &&
      String(asset.contractAddressOrMint || "") === "native:56",
  );
}
