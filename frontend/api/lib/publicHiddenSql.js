// SQL for the publicHidden rule, without a database import, so read models
// that take an injected db (finance fee routing) can use the same definition.
// publicHiddenCampaigns.js re-exports these.

// campaigns.meta->>'publicHidden' = true takes a campaign out of every public
// listing. One definition, so a surface cannot drift.
export function publicHiddenWhere(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return `lower(coalesce(${prefix}meta->>'publicHidden', 'false')) in ('true', '1', 'yes', 'on')`;
}

// SQL fragment for event tables (reward_events, votes, escrow events, ...):
// true when the row's campaign is not a hidden test coin. Rows without a
// campaign pass. Same address rule as publicCampaignKey: Solana keeps case.
export function notPublicHiddenCampaignSql(alias, column = "campaign_address") {
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
