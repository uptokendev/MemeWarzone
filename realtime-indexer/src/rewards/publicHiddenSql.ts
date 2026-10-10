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

// Blocked coins (Command Center -> Abuse -> Blocked coins, 2026-10-10): same rule as the API copy.
// An active public.blocked_coins row takes a coin out of the leagues like publicHidden does. EVM
// addresses are stored lower-case, Solana (101/102) as-is. The fragment is only added once
// probeBlockedCoinsTable() has seen the table (db/migrations/20261010_000020_blocked_coins.sql);
// before that the *OrBlocked helpers return exactly the publicHidden SQL.
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

let blockedCoinsTable = false;
let blockedProbe: Promise<boolean> | null = null;
let blockedProbeAt = 0;
const BLOCKED_REPROBE_MS = 60_000;

export function blockedCoinsTablePresent(): boolean {
  return blockedCoinsTable;
}

/** Tests only: force the probe result (null resets it). */
export function setBlockedCoinsTablePresent(value: boolean | null): void {
  blockedCoinsTable = Boolean(value);
  blockedProbe = value == null ? null : Promise.resolve(blockedCoinsTable);
  blockedProbeAt = value == null ? 0 : Date.now();
}

/** Checks whether public.blocked_coins exists. Sticky once seen; rechecked at most once a minute. Never throws. */
export function probeBlockedCoinsTable(db: Queryable | null | undefined): Promise<boolean> {
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

function addrKeySql(alias: string, column: string): string {
  const ref = `${alias}.${column}`;
  return `(case when ${alias}.chain_id in (101, 102) then ${ref} else lower(${ref}) end)`;
}

export function blockedCampaignSql(alias: string): string {
  if (!alias) throw new Error("blockedCampaignSql needs the campaigns alias");
  return `exists (
    select 1 from public.blocked_coins bc
     where bc.released_at is null
       and bc.chain_id = ${alias}.chain_id
       and (bc.campaign_address = ${addrKeySql(alias, "campaign_address")}
            or bc.token_address = ${addrKeySql(alias, "token_address")})
  )`;
}

export function publicHiddenOrBlockedWhere(alias: string): string {
  if (!alias) throw new Error("publicHiddenOrBlockedWhere needs the campaigns alias");
  const hidden = publicHiddenWhere(alias);
  if (!blockedCoinsTable) return hidden;
  return `(${hidden} or ${blockedCampaignSql(alias)})`;
}

export function notPublicHiddenOrBlockedCampaignSql(alias: string, column = "campaign_address"): string {
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
