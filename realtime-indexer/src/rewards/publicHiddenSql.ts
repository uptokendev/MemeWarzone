// Hidden test coins -- the indexer's copy of frontend/api/lib/publicHiddenSql.js (that file is the
// canonical rule). src/tests/hiddenTestCoinLeagues.integration.test.ts fails if the two drift.
//
// campaigns.meta->>'publicHidden' = true marks a test coin: out of every public listing and, since
// 2026-10-05 (founder: keep test data out of the leagues), out of every league field. Activity on
// such a coin wins no place: per-coin categories skip the coin, wallet categories do not count its
// trades, and the recruiter league does not count its volume or recruiter credit. The league pot is
// not touched (the fee is in the vault either way). Selection only: nothing here rewrites a posted root.

export function publicHiddenWhere(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `lower(coalesce(${prefix}meta->>'publicHidden', 'false')) in ('true', '1', 'yes', 'on')`;
}

// For event tables (curve_trades, reward_events, ...): true when the row's campaign is not a hidden
// test coin. Rows without a campaign pass. Solana keeps case, EVM is case-insensitive.
export function notPublicHiddenCampaignSql(alias: string, column = "campaign_address"): string {
  const ref = `${alias}.${column}`;
  return `not exists (
    select 1 from public.campaigns hc
     where hc.chain_id = ${alias}.chain_id
       and hc.campaign_address is not null
       and (case when hc.chain_id in (101, 102) then hc.campaign_address = ${ref}
                 else lower(hc.campaign_address) = lower(${ref}) end)
       and ${publicHiddenWhere("hc")}
  )`;
}
