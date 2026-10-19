/**
 * Campaign-contract reads a gen-6/7 token page makes. A gen-8 coin has no campaign contract.
 * Skipping these is the whole of the gen-8 change: the functions that perform the reads are unchanged,
 * and a page whose generation is not 8 still calls them.
 *
 * Not a campaign method, also skipped on a gen-8 page:
 *   eth_getBalance of the token (the bonding reserve)
 *   the factory campaign-page scan for createdAt
 *   the TokensPurchased / TokensSold log scan over the last 10,000 blocks
 *     (fetchCampaignActivity runs it only after buyersCount / totalBuyVolumeWei / totalSellVolumeWei revert)
 *
 * totalBuyVolumeWei() is selector 0x86f2ece0. Home grids and the war room call the same methods through
 * fetchOnChainCampaignStats and onChainLeagueSummary. Those are not the token page.
 */

export const GEN8_SKIPPED_CAMPAIGN_READS = Object.freeze([
  "token()",
  "creator()",
  "logoURI()",
  "sold()",
  "curveSupply()",
  "liquiditySupply()",
  "creatorReserve()",
  "basePrice()",
  "priceSlope()",
  "graduationTarget()",
  "liquidityBps()",
  "protocolFeeBps()",
  "currentPrice()",
  "launched()",
  "finalizedAt()",
  "graduationNativeTarget()",
  "virtualNative()",
  "virtualToken()",
  "buyersCount()",
  "totalBuyVolumeWei()",
  "totalSellVolumeWei()",
  "getGraduationState()",
  "quoteBuyExactBnb(uint256)",
  "quoteBuyExactTokens(uint256)",
  "quoteSellExactTokens(uint256)",
]);

export function isGen8CoinPage(campaign) {
  return Number(campaign?.generation) === 8;
}

/** False only when the indexer row is already generation 8. Missing or any other generation still reads the campaign. */
export function shouldReadLegacyCampaign(identity) {
  const generation = Number(identity?.generation ?? identity?.factoryGeneration);
  return generation !== 8;
}

/** The campaign reads this page will make. Empty for a gen-8 coin. The full list for gen-6 and gen-7. */
export function campaignReadsFor(page) {
  if (!page || isGen8CoinPage(page) || !shouldReadLegacyCampaign(page)) return [];
  return GEN8_SKIPPED_CAMPAIGN_READS;
}
