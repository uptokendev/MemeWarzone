import { pool } from "../../server/db.js";
import { probeBlockedCoinsTable, publicHiddenWhere } from "./publicHiddenSql.js";
import { loadActiveBlocks } from "./blockedCoins.js";

// campaigns.meta->>'publicHidden' = true takes a campaign out of every public
// listing: the feed, trending, and the league standings. Direct token links
// keep working and the indexer keeps writing the row; only discovery hides it.
//
// One definition, so a surface cannot drift: the feed used to be the only
// reader, which is how hidden test campaigns still showed up in the leagues.

// The SQL lives in publicHiddenSql.js (no database import) so injected-db read
// models share this exact definition.
export {
  notBlockedCoinSql,
  notPublicHiddenCampaignSql,
  notPublicHiddenOrBlockedCampaignSql,
  publicHiddenOrBlockedWhere,
  publicHiddenWhere,
} from "./publicHiddenSql.js";

// Blocked coins (lib/blockedCoins.js): look for the table as soon as the API loads, so the listing
// SQL includes blocks from the first requests on.
void probeBlockedCoinsTable(pool);

// Same key the feed uses: Solana base58 keeps its case, EVM is case-insensitive.
export function publicCampaignKey(chainId, campaignAddress) {
  const chain = Number(chainId);
  const addr = String(campaignAddress || "").trim();
  if (chain === 101 || chain === 102) return `${chain}:${addr}`;
  return `${chain}:${addr.toLowerCase()}`;
}

/**
 * Keys of every campaign kept out of public lists on a chain: meta.publicHidden test coins and, unless
 * includeBlocked is false, coins with an active block (both their campaign and token keys).
 * includeBlocked: false is the plain test-coin set (finance labels).
 */
export async function loadPublicHiddenCampaignKeys(chainId, { includeBlocked = true } = {}) {
  const result = await pool.query(
    `select campaign_address
       from public.campaigns
      where chain_id = $1
        and campaign_address is not null
        and ${publicHiddenWhere()}`,
    [Number(chainId)],
  );
  const keys = new Set((result.rows || []).map((row) => publicCampaignKey(chainId, row.campaign_address)));
  if (includeBlocked) {
    for (const block of await loadActiveBlocks(pool, chainId)) {
      if (block.campaign_address) keys.add(publicCampaignKey(chainId, block.campaign_address));
      if (block.token_address) keys.add(publicCampaignKey(chainId, block.token_address));
    }
  }
  return keys;
}

// Drops rows whose campaign is hidden. Rows without a campaign (wallet
// leagues such as top_earner and the recruiter league) pass through untouched.
export function withoutPublicHidden(rows, chainId, hidden, pick = (row) => row?.campaign_address ?? row?.campaignAddress) {
  if (!hidden || !hidden.size || !Array.isArray(rows)) return rows;
  return rows.filter((row) => {
    const address = pick(row);
    return !address || !hidden.has(publicCampaignKey(chainId, address));
  });
}
