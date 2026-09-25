/**
 * campaigns.meta->>'publicHidden' = true marks a retired test campaign. The API already keeps them
 * out of every public listing (frontend/api/lib/publicHiddenCampaigns.js, same definition). The
 * indexer's background loops kept repairing, re-pricing and polling their dead Meteora pools every
 * few seconds -- load and log noise that grows with every retired campaign. Program-level trade
 * ingestion is unaffected: a trade on a hidden campaign is still stored.
 */
export function notPublicHiddenSql(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `lower(coalesce(${prefix}meta->>'publicHidden', 'false')) not in ('true', '1', 'yes', 'on')`;
}
