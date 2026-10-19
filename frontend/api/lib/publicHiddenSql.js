// SQL for the publicHidden rule, without a database import, so read models
// that take an injected db (finance fee routing) can use the same definition.
// publicHiddenCampaigns.js re-exports these.

// campaigns.meta->>'publicHidden' = true takes a campaign out of every public
// listing. One definition, so a surface cannot drift.
export function publicHiddenWhere(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return `lower(coalesce(${prefix}meta->>'publicHidden', 'false')) in ('true', '1', 'yes', 'on')`;
}

// Draft row matches a campaigns row. Solana keeps case. EVM compares lower-case.
// Either side may store the campaign id or the token address.
function draftMatchesCampaignSql(draftAlias, campaignAlias) {
  const d = draftAlias;
  const c = campaignAlias;
  const same = (left, right) =>
    `(case when ${d}.chain_id in (101, 102) then ${left} = ${right} else lower(${left}) = lower(${right}) end)`;
  return `(
    (${d}.campaign_address is not null and ${same(`${d}.campaign_address`, `${c}.campaign_address`)})
    or (${c}.token_address is not null and ${d}.campaign_address is not null and ${same(`${d}.campaign_address`, `${c}.token_address`)})
    or (${c}.token_address is not null and ${d}.token_address is not null and ${same(`${d}.token_address`, `${c}.token_address`)})
    or (${d}.token_address is not null and ${same(`${d}.token_address`, `${c}.campaign_address`)})
  )`;
}

// A campaign whose draft is armed for a future trading-open time. The pool can
// already exist. Public listings, search, and the launch feed stay quiet until
// scheduled_launch_at. The promotion page is the public surface until then.
// Solana countdown launches and gen-8 openAt launches both write this column.
export function futureScheduledLaunchExists(alias = "c") {
  const a = alias || "c";
  return `exists (
    select 1 from public.campaign_drafts d_sched
     where d_sched.chain_id = ${a}.chain_id
       and d_sched.scheduled_launch_at > now()
       and ${draftMatchesCampaignSql("d_sched", a)}
  )`;
}

// Gen-8 pool whose on-chain openAt is still ahead. Only emit this when
// evm_gen8_pools.open_at exists (gen8Tables().phase). A coin the draft mark
// left as deployed is still closed while this time is in the future.
export function futureGen8OpenExists(alias = "c") {
  const a = alias || "c";
  return `exists (
    select 1 from public.evm_gen8_pools g8_wait
     where g8_wait.chain_id = ${a}.chain_id
       and g8_wait.open_at > now()
       and (
         lower(g8_wait.token_address) = lower(${a}.campaign_address)
         or (${a}.token_address is not null and lower(g8_wait.token_address) = lower(${a}.token_address))
       )
  )`;
}

// True while trading is still closed. gen8OpenAt adds the pool clock. Leave it
// false where the gen-8 tables are not installed.
export function tradingNotOpenSql(alias = "c", { gen8OpenAt = false } = {}) {
  const draft = futureScheduledLaunchExists(alias);
  if (!gen8OpenAt) return draft;
  return `(${draft} or ${futureGen8OpenExists(alias)})`;
}

// Feed time for a launch: the trading-open time when that is later than the
// chain create, so the "launched" card appears when the timer ends.
export function publicLaunchAtSql(alias = "c", { gen8OpenAt = false } = {}) {
  const a = alias || "c";
  const created = `coalesce(${a}.created_at_chain, ${a}.created_at)`;
  const scheduled = `(
      select max(d_sched.scheduled_launch_at)
        from public.campaign_drafts d_sched
       where d_sched.chain_id = ${a}.chain_id
         and d_sched.scheduled_launch_at <= now()
         and ${draftMatchesCampaignSql("d_sched", a)}
    )`;
  const parts = [created, `coalesce(${scheduled}, ${created})`];
  if (gen8OpenAt) {
    const opened = `(
      select max(g8_wait.open_at)
        from public.evm_gen8_pools g8_wait
       where g8_wait.chain_id = ${a}.chain_id
         and g8_wait.open_at <= now()
         and (
           lower(g8_wait.token_address) = lower(${a}.campaign_address)
           or (${a}.token_address is not null and lower(g8_wait.token_address) = lower(${a}.token_address))
         )
    )`;
    parts.push(`coalesce(${opened}, ${created})`);
  }
  return `greatest(\n    ${parts.join(",\n    ")}\n  )`;
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
