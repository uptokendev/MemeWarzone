// Protocol revenue lanes beyond bonding-curve trades and UP votes, for
// revenueLanes() in admin/finance.js (shared by /revenue, /summary and the
// month close). Read-only: SELECT aggregates on tables the app already writes.
//
// Each lane is the PROTOCOL share only. Prize money (75% of entries, 90% of
// boosts, 70% of sponsorships) and the 20% Major War League share are held for
// others and never appear here (they are in Payouts and in the fee-routing
// "held for others" balances).
//
//   arena_boosts      10% of confirmed arena boosts (battles, vote battles,
//                     tournament matches). Counted once the battle (and its
//                     tournament, if any) finished: a cancelled pool refunds
//                     boosts in full (programs/mwz_rewards_treasury/src/arena.rs:39-41,
//                     357-360, 612-627; contracts/ArenaWarPoolTreasuryV2.sol:79,508).
//   arena_entries     5% of battle stakes, support and tournament buy-ins.
//                     Read from the MWL share ledger: the program takes 20% for
//                     the MWL and 5% for the protocol of the same base
//                     (arena.rs:36-37,690-698; ArenaWarPoolTreasuryV2.sol:77-78,
//                     503-505), so protocol = floor(league share / 4). The
//                     ledger row is written when the crank claims the league
//                     share (arenaLeagueShareLedger.js), i.e. after resolution.
//   sponsorships      20% marketing + 10% protocol of confirmed event
//                     sponsorship payments; both receivers are the protocol
//                     vault on mainnet (arena_money_v2/sponsorship.rs:11-13;
//                     WarzoneSponsorshipRouterV1.sol:23-24). No refund path.
//   home_placements   Home top row / featured slots sold off-chain. USD price
//                     of placements an admin marked paid (admin/sponsorship.js
//                     patchApplication sets paid_at). No on-chain proof exists.
//   dbc_referral      Meteora DBC referral fee (20% of Meteora's cut) on swaps
//                     made on our site; swept weekly to protocol_vault
//                     (realtime-indexer/src/dbc/dbcReferralSweep.ts:80-100).
//   graduation_fee    EVM finalize protocol slice (RouteExecuted kind 1 ->
//                     route_kind 'finalize', realtime-indexer/src/indexer.ts:1280).
//                     Solana graduation (FeeSlicesRouted) is stored as
//                     route_kind 'trade' and is already in the bonding lane.
//
// Test coins: a row whose campaign (or either battle side) is a hidden test
// campaign is left out; a row without a campaign passes.

import { publicHiddenWhere } from "./publicHiddenSql.js";

export const USD_CENTS_DECIMALS = 2;

/** Where each lane's money lands, per chain family (fee-routing destination ids). */
const INVENTORY = Object.freeze({
  solana: Object.freeze({ arena: "sol101-mainnet-protocol-vault", sponsorship: "sol101-mainnet-protocol-vault", dbcReferral: "sol101-mainnet-dbc-referral" }),
  evm: Object.freeze({ arena: "safe", sponsorship: "protocol-vault", finalize: "treasury-router" }),
});

function evmPrefix(network) {
  return network.chain === "robinhood" ? `rh${network.chainId}` : `bnb${network.chainId}`;
}

function inventoryId(network, key) {
  if (network.chain === "solana") return INVENTORY.solana[key];
  return `${evmPrefix(network)}-${INVENTORY.evm[key]}`;
}

function isSchemaMissing(error) {
  return ["42P01", "42703"].includes(String(error?.code || ""));
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function atomicToDecimal(raw, decimals) {
  const text = String(raw ?? "").split(".")[0];
  if (!/^\d+$/.test(text)) return null;
  if (decimals === 0) return text.replace(/^0+(?=\d)/, "");
  const padded = text.replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Hourly rows ({hour, period_start, period_end, evidence_count, amount_raw}) to one lane, or null when nothing was earned. */
export function laneFromHourlyRows(rows, { id, chain, lane, source, assetSymbol, decimals, sourceInventoryId }) {
  let total = 0n;
  let evidenceCount = 0;
  let periodStart = null;
  let periodEnd = null;
  const buckets = [];
  for (const row of rows || []) {
    const raw = String(row.amount_raw ?? "0").split(".")[0];
    if (!/^\d+$/.test(raw)) continue;
    total += BigInt(raw);
    evidenceCount += Number(row.evidence_count || 0);
    const start = toIso(row.period_start);
    const end = toIso(row.period_end);
    if (start && (!periodStart || start < periodStart)) periodStart = start;
    if (end && (!periodEnd || end > periodEnd)) periodEnd = end;
    buckets.push({ hour: row.hour, raw });
  }
  if (total === 0n || !periodStart || !periodEnd) return null;
  return {
    aggregate: {
      id,
      periodStart,
      periodEnd,
      chain,
      lane,
      source,
      assetSymbol,
      decimals,
      sourceInventoryId,
      nativeAmount: atomicToDecimal(total.toString(), decimals),
      evidenceCount,
    },
    buckets,
  };
}

// A battle is a test battle when either side, or its primary campaign, is a
// hidden test campaign (by campaign address or mint / token address).
function battleNotHiddenSql(alias) {
  const sides = [`${alias}.primary_campaign_address`, `${alias}.challenger_token`, `${alias}.defender_token`];
  const match = sides
    .map((ref) => `(case when hc.chain_id in (101, 102) then hc.campaign_address = ${ref} or hc.token_address = ${ref}
                        else lower(hc.campaign_address) = lower(${ref}) or lower(hc.token_address) = lower(${ref}) end)`)
    .join(" or ");
  return `not exists (
    select 1 from public.campaigns hc
     where hc.chain_id = ${alias}.chain_id
       and (${match})
       and ${publicHiddenWhere("hc")}
  )`;
}

function campaignNotHiddenSql(chainExpr, ref) {
  return `not exists (
    select 1 from public.campaigns hc
     where hc.chain_id = ${chainExpr}
       and hc.campaign_address is not null
       and (case when hc.chain_id in (101, 102) then hc.campaign_address = ${ref}
                 else lower(hc.campaign_address) = lower(${ref}) end)
       and ${publicHiddenWhere("hc")}
  )`;
}

const HOURLY = (timeExpr) => `date_trunc('hour', ${timeExpr}) as hour,
            min(${timeExpr}) as period_start,
            max(${timeExpr}) as period_end,
            count(*)::int as evidence_count`;

export const LANE_QUERIES = Object.freeze({
  arena_boosts: `
    select ${HOURLY("a.confirmed_at")},
           coalesce(sum(a.protocol_native_raw), 0)::text as amount_raw
      from public.arena_contest_actions a
      join public.arena_battles b on b.id = a.battle_id and b.chain_id = a.chain_id
      left join public.arena_tournaments t on t.id::text = a.tournament_id::text
     where a.chain_id = $1
       and a.action_type = 'boost'
       and a.confirmed_at is not null
       and coalesce(a.tx_hash, a.signature_reference) is not null
       and a.protocol_native_raw > 0
       and b.state = 'finished'
       and (a.tournament_id is null or t.status = 'finished')
       and ${battleNotHiddenSql("b")}
     group by 1`,
  arena_boosts_excluded: `
    select count(*)::int as n
      from public.arena_contest_actions a
      join public.arena_battles b on b.id = a.battle_id and b.chain_id = a.chain_id
     where a.chain_id = $1
       and a.action_type = 'boost'
       and a.confirmed_at is not null
       and a.protocol_native_raw > 0
       and not ${battleNotHiddenSql("b")}`,
  arena_entries: `
    select ${HOURLY("coalesce(b.settled_at, l.created_at)")},
           coalesce(sum(floor(l.gross_raw / 4)), 0)::text as amount_raw
      from public.arena_league_share_ledger l
      left join public.arena_battles b on l.subject_kind = 'battle' and b.id = l.subject_id and b.chain_id = l.chain_id
     where l.chain_id = $1
       and l.gross_raw > 0
       and (b.id is null or ${battleNotHiddenSql("b")})
     group by 1`,
  sponsorships: `
    select ${HOURLY("p.confirmed_at")},
           coalesce(sum(coalesce(p.marketing_native_raw, 0) + coalesce(p.protocol_native_raw, 0)), 0)::text as amount_raw
      from public.sponsorship_payments p
     where p.chain_id = $1
       and p.status = 'confirmed'
       and p.confirmed_at is not null
     group by 1`,
  home_placements: `
    select ${HOURLY("coalesce(a.paid_at, p.approved_at, p.starts_at)")},
           coalesce(sum(round(coalesce(p.package_price_usd, a.package_price_usd, a.payment_due_usd) * 100)), 0)::text as amount_raw
      from public.sponsored_placements p
      left join public.sponsorship_applications a on a.id = p.application_id
     where p.chain_id = $1
       and p.payment_status in ('paid', 'verified')
       and coalesce(a.status, '') <> 'rejected'
       and coalesce(p.package_price_usd, a.package_price_usd, a.payment_due_usd) > 0
       and coalesce(a.paid_at, p.approved_at, p.starts_at) is not null
       and (p.campaign_address is null or ${campaignNotHiddenSql("p.chain_id", "p.campaign_address")})
     group by 1`,
  dbc_referral: `
    select ${HOURLY("d.created_at")},
           coalesce(sum(d.referral_fee), 0)::text as amount_raw
      from public.dbc_fee_accruals d
     where $1::int = 101
       and d.referral_fee > 0
       and ${campaignNotHiddenSql("101", "d.pool")}
     group by 1`,
  graduation_fee: `
    select ${HOURLY("r.occurred_at")},
           coalesce(sum(r.protocol_amount), 0)::text as amount_raw
      from public.reward_events r
     where r.chain_id = $1
       and r.route_kind = 'finalize'
       and r.protocol_amount > 0
       and ${campaignNotHiddenSql("r.chain_id", "r.campaign_address")}
     group by 1`,
});

/** Lane definitions for one network: which query, label and asset. */
export function laneDefinitions(network) {
  const native = { assetSymbol: network.asset, decimals: network.decimals };
  const defs = [
    { key: "arena_boosts", lane: "other_approved", source: "Arena boosts 10%", ...native, sourceInventoryId: inventoryId(network, "arena") },
    { key: "arena_entries", lane: "other_approved", source: "Battle entries 5% (stakes, support, tournament buy-ins)", ...native, sourceInventoryId: inventoryId(network, "arena") },
    { key: "sponsorships", lane: "sponsorship", source: "Sponsorships 10% + marketing 20%", ...native, sourceInventoryId: inventoryId(network, "sponsorship") },
    { key: "home_placements", lane: "sponsorship", source: "Home placements (marked paid by admin, off-chain)", assetSymbol: "USD", decimals: USD_CENTS_DECIMALS, sourceInventoryId: "off-chain-sponsorship-applications" },
  ];
  if (network.chain === "solana") {
    defs.push({ key: "dbc_referral", lane: "other_approved", source: "Meteora DBC referral (20% of Meteora's cut)", ...native, sourceInventoryId: inventoryId(network, "dbcReferral") });
  } else {
    defs.push({ key: "graduation_fee", lane: "bonding_curve_fee", source: "Graduation fee (finalize) protocol share", ...native, sourceInventoryId: inventoryId(network, "finalize") });
  }
  return defs;
}

/**
 * The extra revenue lanes of one mainnet. `db` is a pg pool (injected for
 * tests). A table that does not exist yet drops its lane; any other error is
 * logged and drops only that lane, never the whole revenue read.
 * @returns {Promise<{lanes: Array<{aggregate: object, buckets: Array<{hour: any, raw: string}>}>, excludedEvents: number}>}
 */
export async function extraRevenueLanes(db, network, { log = console } = {}) {
  const lanes = [];
  let excludedEvents = 0;
  for (const def of laneDefinitions(network)) {
    try {
      const { rows } = await db.query(LANE_QUERIES[def.key], [network.chainId]);
      const lane = laneFromHourlyRows(rows, {
        id: `${def.key.replaceAll("_", "-")}:${network.chainId}`,
        chain: network.chain,
        lane: def.lane,
        source: def.source,
        assetSymbol: def.assetSymbol,
        decimals: def.decimals,
        sourceInventoryId: def.sourceInventoryId,
      });
      if (lane) lanes.push(lane);
    } catch (error) {
      if (!isSchemaMissing(error)) log.warn?.(`[finance/revenue] ${def.key} lane omitted`, error?.message || error);
    }
  }
  try {
    const { rows } = await db.query(LANE_QUERIES.arena_boosts_excluded, [network.chainId]);
    excludedEvents += Number(rows?.[0]?.n || 0);
  } catch (error) {
    if (!isSchemaMissing(error)) log.warn?.("[finance/revenue] arena test-coin count omitted", error?.message || error);
  }
  return { lanes, excludedEvents };
}

/** Decimals of a lane: its own (USD cents, ...) or the chain's native decimals. */
export function laneDecimals(lane, network) {
  return Number.isInteger(lane?.aggregate?.decimals) ? lane.aggregate.decimals : network.decimals;
}

/** /revenue aggregates: each lane valued at its event hours (one rule for /revenue and /summary). */
export async function valueRevenueLanes(lanes, network, prices) {
  const aggregates = [];
  for (const lane of lanes) {
    const usd = await prices.valueEvents(lane.aggregate.assetSymbol, lane.buckets, laneDecimals(lane, network));
    aggregates.push({ ...lane.aggregate, chainId: network.chainId, ...usd });
  }
  return aggregates;
}

/** /summary revenue read from the same lanes. */
export function summaryRevenueLanes(lanes, network) {
  return lanes.map((lane) => ({ asset: lane.aggregate.assetSymbol, decimals: laneDecimals(lane, network), buckets: lane.buckets }));
}
