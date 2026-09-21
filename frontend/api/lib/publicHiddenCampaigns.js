import { pool } from "../../server/db.js";

// campaigns.meta->>'publicHidden' = true takes a campaign out of every public
// listing: the feed, trending, and the league standings. Direct token links
// keep working and the indexer keeps writing the row; only discovery hides it.
//
// One definition, so a surface cannot drift: the feed used to be the only
// reader, which is how hidden test campaigns still showed up in the leagues.

export function publicHiddenWhere(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return `lower(coalesce(${prefix}meta->>'publicHidden', 'false')) in ('true', '1', 'yes', 'on')`;
}

// Same key the feed uses: Solana base58 keeps its case, EVM is case-insensitive.
export function publicCampaignKey(chainId, campaignAddress) {
  const chain = Number(chainId);
  const addr = String(campaignAddress || "").trim();
  if (chain === 101 || chain === 102) return `${chain}:${addr}`;
  return `${chain}:${addr.toLowerCase()}`;
}

export async function loadPublicHiddenCampaignKeys(chainId) {
  const result = await pool.query(
    `select campaign_address
       from public.campaigns
      where chain_id = $1
        and campaign_address is not null
        and ${publicHiddenWhere()}`,
    [Number(chainId)],
  );
  return new Set((result.rows || []).map((row) => publicCampaignKey(chainId, row.campaign_address)));
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
