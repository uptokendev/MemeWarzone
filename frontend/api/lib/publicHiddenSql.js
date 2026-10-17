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

// Blocked coins (Command Center -> Abuse -> Blocked coins, 2026-10-10): a coin with an active
// public.blocked_coins row is out of the same public listings as a publicHidden coin. Blocks store
// EVM addresses lower-case and Solana (101/102) addresses as-is.
//
// The table arrives with db/migrations/20261010_000020_blocked_coins.sql. Before it exists a query
// naming it fails to parse (42P01), so the fragment is only added once probeBlockedCoinsTable() has
// seen the table. Until then the *OrBlocked helpers return exactly the publicHidden SQL above.
// Finance and analytics keep the plain publicHidden rule: a blocked coin's real fees stay counted.
let blockedCoinsTable = false;
let blockedProbe = null;
let blockedProbeAt = 0;
const BLOCKED_REPROBE_MS = 60_000;

export function blockedCoinsTablePresent() {
  return blockedCoinsTable;
}

/** Tests only: force the probe result. */
export function setBlockedCoinsTablePresent(value) {
  blockedCoinsTable = Boolean(value);
  blockedProbe = value == null ? null : Promise.resolve(blockedCoinsTable);
  blockedProbeAt = value == null ? 0 : Date.now();
}

/**
 * Checks once whether public.blocked_coins exists (db: anything with query()). Once seen it stays on;
 * while missing it is checked again at most once a minute. Never throws.
 */
export function probeBlockedCoinsTable(db) {
  if (blockedCoinsTable) return Promise.resolve(true);
  if (blockedProbe && Date.now() - blockedProbeAt < BLOCKED_REPROBE_MS) return blockedProbe;
  if (!db || typeof db.query !== "function") return Promise.resolve(false);
  blockedProbeAt = Date.now();
  blockedProbe = Promise.resolve()
    .then(() => db.query(`select to_regclass('public.blocked_coins') is not null as present`))
    .then((r) => {
      blockedCoinsTable = Boolean(r?.rows?.[0]?.present);
      return blockedCoinsTable;
    })
    .catch(() => false);
  return blockedProbe;
}

function addrKeySql(alias, column) {
  const ref = `${alias}.${column}`;
  return `(case when ${alias}.chain_id in (101, 102) then ${ref} else lower(${ref}) end)`;
}

/** True when the campaigns row `alias` has an active block. Requires an alias. */
export function blockedCampaignSql(alias) {
  if (!alias) throw new Error("blockedCampaignSql needs the campaigns alias");
  return `exists (
    select 1 from public.blocked_coins bc
     where bc.released_at is null
       and bc.chain_id = ${alias}.chain_id
       and (bc.campaign_address = ${addrKeySql(alias, "campaign_address")}
            or bc.token_address = ${addrKeySql(alias, "token_address")})
  )`;
}

/** publicHiddenWhere plus active blocks, for public listings. Parenthesised: safe after NOT. */
export function publicHiddenOrBlockedWhere(alias) {
  if (!alias) throw new Error("publicHiddenOrBlockedWhere needs the campaigns alias");
  const hidden = publicHiddenWhere(alias);
  if (!blockedCoinsTable) return hidden;
  return `(${hidden} or ${blockedCampaignSql(alias)})`;
}

/** notPublicHiddenCampaignSql plus active blocks, for event tables. */
export function notPublicHiddenOrBlockedCampaignSql(alias, column = "campaign_address") {
  const ref = `${alias}.${column}`;
  return `not exists (
    select 1 from public.campaigns hc
     where hc.chain_id = ${alias}.chain_id
       and hc.campaign_address is not null
       and (case when hc.chain_id in (101, 102) then hc.campaign_address = ${ref}
                 else lower(hc.campaign_address) = lower(${ref}) end)
       and ${publicHiddenOrBlockedWhere("hc")}
  )`;
}

/**
 * For rows that name a coin by their own columns (drafts, posts with a coin card, coin posts): true
 * when that coin has no active block. Each argument is a SQL expression; campaign or token may be null.
 * "true" until the table exists.
 */
export function notBlockedCoinSql({ chain, campaign = null, token = null }) {
  if (!blockedCoinsTable || (!campaign && !token)) return "true";
  const key = (expr) => `(case when ${chain} in (101, 102) then ${expr} else lower(${expr}) end)`;
  const parts = [];
  if (campaign) parts.push(`bc.campaign_address = ${key(campaign)}`, `bc.token_address = ${key(campaign)}`);
  if (token) parts.push(`bc.token_address = ${key(token)}`, `bc.campaign_address = ${key(token)}`);
  return `not exists (
    select 1 from public.blocked_coins bc
     where bc.released_at is null
       and bc.chain_id = ${chain}
       and (${parts.join(" or ")})
  )`;
}
