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
//   dbc_migration_fee Meteora DBC migration fee, partner share. At migration
//                     the curve pays the config's migration fee: v1 pools 22%
//                     of the threshold, 90% creator / 10% partner (us); v2 pools
//                     (2026-10-08) 2%, all ours. The indexer keeper withdraws
//                     the partner share to the collector, pays a v1 creator
//                     Meteora's 0.2% liquidity cut from it (D7), then
//                     routes the rest with the finalize split (recruiter /
//                     squad / airdrop, protocol the remainder) and writes one
//                     reward_events row: route_kind 'finalize', matched
//                     'dbc_graduation' (realtime-indexer/src/dbc/
//                     dbcGraduationKeeper.ts insertFinalizeRewardEvent,
//                     dbcGraduationSplit.ts finalizeAfterCompensation). The
//                     lane is that row's protocol_amount, which lands in
//                     protocol_vault. Native-SOL coins only: for a bound-quote
//                     coin the row is in quote units, so it is counted apart
//                     (dbc_migration_fee_bound_quote) and named in a note.
//   graduation_fee    EVM finalize protocol slice (RouteExecuted kind 1 ->
//                     route_kind 'finalize', realtime-indexer/src/indexer.ts:1280).
//                     Solana launchpad graduation (FeeSlicesRouted) is stored
//                     as route_kind 'trade' and is already in the bonding lane;
//                     Solana 'finalize' rows are DBC migrations (above).
//   import_swaps      0.5% platform fee on imported-coin swaps (Jupiter on
//                     Solana, KyberSwap on BNB, Universal Router on Robinhood),
//                     read from the chain into finance_import_swap_fees by
//                     financeImportSwapFees.js (cron:finance-snapshots). Imported
//                     coins are never our campaigns, so there is no test-coin
//                     filter. Swaps by our own wallets (internal_wallet) are
//                     left out of revenue (founder 2026-10-06); they stay in
//                     the table.
//
// Test coins: a row whose campaign (or either battle side) is a hidden test
// campaign is left out; a row without a campaign passes.

import { publicHiddenWhere } from "./publicHiddenSql.js";
import { snapshotCacheFor, snapshotKeys } from "./financeSnapshots.js";

export const USD_CENTS_DECIMALS = 2;

/** Where each lane's money lands, per chain family (fee-routing destination ids). */
const INVENTORY = Object.freeze({
  solana: Object.freeze({ arena: "sol101-mainnet-protocol-vault", sponsorship: "sol101-mainnet-protocol-vault", dbcReferral: "sol101-mainnet-dbc-referral", dbcMigration: "sol101-mainnet-protocol-vault", importSwap: "sol101-mainnet-import-swap-fee" }),
  evm: Object.freeze({ arena: "safe", sponsorship: "protocol-vault", finalize: "treasury-router", importSwap: "protocol-vault" }),
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
    buckets.push({ hour: row.hour, raw, evidenceCount: Number(row.evidence_count || 0) });
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

// One spec per lane: FROM / WHERE / time / amount. The hourly query (/revenue,
// /summary, Close) and the per-event query (revenue CSV) are both built from
// it, so the two can never filter differently. $1 is always the chain id.
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// The DBC campaign's quote is SOL (unset meta = SOL, the default launch).
function dbcQuoteIsSolSql(chainExpr, ref, negate = false) {
  return `${negate ? "" : "not "}exists (
    select 1 from public.campaigns qc
     where qc.chain_id = ${chainExpr}
       and qc.campaign_address = ${ref}
       and coalesce(nullif(qc.meta #>> '{dbc,quoteMint}', ''), '${WSOL_MINT}') <> '${WSOL_MINT}'
  )`;
}

const DBC_MIGRATION_WHERE = `r.chain_id = $1
       and $1::int = 101
       and r.route_kind = 'finalize'
       and r.matched_activity_source = 'dbc_graduation'
       and r.protocol_amount > 0`;

const NATIVE_VOTE_ASSET = { solana: "11111111111111111111111111111111", evm: "0x0000000000000000000000000000000000000000" };

export const LANE_SPECS = Object.freeze({
  bonding: {
    from: "public.reward_events r",
    where: `r.chain_id = $1
       and r.route_kind = 'trade'
       and r.protocol_amount > 0
       and ${campaignNotHiddenSql("r.chain_id", "r.campaign_address")}`,
    time: "r.occurred_at", amount: "r.protocol_amount",
    tx: "r.tx_hash", logIndex: "r.log_index", campaign: "r.campaign_address", ref: "r.source_event", eventId: "r.id::text",
  },
  upvotes_solana: {
    from: "public.votes v",
    where: `v.chain_id = $1
       and v.status = 'confirmed'
       and lower(v.asset_address) = lower('${NATIVE_VOTE_ASSET.solana}')
       and ${campaignNotHiddenSql("v.chain_id", "v.campaign_address")}`,
    time: "v.block_timestamp", amount: "v.amount_raw",
    tx: "v.tx_hash", logIndex: "v.log_index", campaign: "v.campaign_address", ref: "null::text", eventId: "v.id::text",
  },
  upvotes_evm: {
    from: "public.votes v",
    where: `v.chain_id = $1
       and v.status = 'confirmed'
       and lower(v.asset_address) = lower('${NATIVE_VOTE_ASSET.evm}')
       and ${campaignNotHiddenSql("v.chain_id", "v.campaign_address")}`,
    time: "v.block_timestamp", amount: "v.amount_raw",
    tx: "v.tx_hash", logIndex: "v.log_index", campaign: "v.campaign_address", ref: "null::text", eventId: "v.id::text",
  },
  arena_boosts: {
    from: `public.arena_contest_actions a
      join public.arena_battles b on b.id = a.battle_id and b.chain_id = a.chain_id
      left join public.arena_tournaments t on t.id::text = a.tournament_id::text`,
    where: `a.chain_id = $1
       and a.action_type = 'boost'
       and a.confirmed_at is not null
       and coalesce(a.tx_hash, a.signature_reference) is not null
       and a.protocol_native_raw > 0
       and b.state = 'finished'
       and (a.tournament_id is null or t.status = 'finished')
       and ${battleNotHiddenSql("b")}`,
    time: "a.confirmed_at", amount: "a.protocol_native_raw",
    tx: "coalesce(a.tx_hash, a.signature_reference)", logIndex: "a.log_index", campaign: "null::text", ref: "a.battle_id::text", eventId: "a.id::text",
  },
  arena_entries: {
    from: `public.arena_league_share_ledger l
      left join public.arena_battles b on l.subject_kind = 'battle' and b.id = l.subject_id and b.chain_id = l.chain_id`,
    where: `l.chain_id = $1
       and l.gross_raw > 0
       and (b.id is null or ${battleNotHiddenSql("b")})`,
    time: "coalesce(b.settled_at, l.created_at)", amount: "floor(l.gross_raw / 4)",
    tx: "l.tx_hash", logIndex: "null::int", campaign: "null::text", ref: "l.subject_id::text", eventId: "l.id::text",
  },
  sponsorships: {
    from: "public.sponsorship_payments p",
    where: `p.chain_id = $1
       and p.status = 'confirmed'
       and p.confirmed_at is not null`,
    time: "p.confirmed_at", amount: "(coalesce(p.marketing_native_raw, 0) + coalesce(p.protocol_native_raw, 0))",
    tx: "coalesce(p.tx_hash, p.signature_reference)", logIndex: "null::int", campaign: "null::text", ref: "p.event_sponsorship_id::text", eventId: "p.id::text",
  },
  home_placements: {
    from: `public.sponsored_placements p
      left join public.sponsorship_applications a on a.id = p.application_id`,
    where: `p.chain_id = $1
       and p.payment_status in ('paid', 'verified')
       and coalesce(a.status, '') <> 'rejected'
       and coalesce(p.package_price_usd, a.package_price_usd, a.payment_due_usd) > 0
       and coalesce(a.paid_at, p.approved_at, p.starts_at) is not null
       and (p.campaign_address is null or ${campaignNotHiddenSql("p.chain_id", "p.campaign_address")})`,
    time: "coalesce(a.paid_at, p.approved_at, p.starts_at)", amount: "round(coalesce(p.package_price_usd, a.package_price_usd, a.payment_due_usd) * 100)",
    tx: "null::text", logIndex: "null::int", campaign: "p.campaign_address", ref: "p.project_name", eventId: "p.id::text",
  },
  // Only referral fees paid to our account: terminals name their own referral on our pools
  // (dbc_fee_accruals.referral_ours, recorded by the indexer from the swap's accounts).
  dbc_referral: {
    from: "public.dbc_fee_accruals d",
    where: `$1::int = 101
       and d.referral_fee > 0
       and d.referral_ours is true
       and ${campaignNotHiddenSql("101", "d.pool")}`,
    time: "d.created_at", amount: "d.referral_fee",
    tx: "d.tx_hash", logIndex: "d.log_index", campaign: "d.pool", ref: "null::text", eventId: "d.id::text",
  },
  dbc_migration_fee: {
    from: "public.reward_events r",
    where: `${DBC_MIGRATION_WHERE}
       and ${dbcQuoteIsSolSql("r.chain_id", "r.campaign_address")}
       and ${campaignNotHiddenSql("r.chain_id", "r.campaign_address")}`,
    time: "r.occurred_at", amount: "r.protocol_amount",
    tx: "r.tx_hash", logIndex: "r.log_index", campaign: "r.campaign_address", ref: "r.source_event", eventId: "r.id::text",
  },
  import_swaps: {
    from: "public.finance_import_swap_fees f",
    where: `f.chain_id = $1
       and f.fee_raw > 0
       and not f.internal_wallet`,
    time: "f.occurred_at", amount: "f.fee_raw",
    tx: "f.tx_hash", logIndex: "f.log_index", campaign: "f.token_address", ref: "f.side", eventId: "f.id::text",
  },
  graduation_fee: {
    from: "public.reward_events r",
    where: `r.chain_id = $1
       and r.route_kind = 'finalize'
       and r.protocol_amount > 0
       and ${campaignNotHiddenSql("r.chain_id", "r.campaign_address")}`,
    time: "r.occurred_at", amount: "r.protocol_amount",
    tx: "r.tx_hash", logIndex: "r.log_index", campaign: "r.campaign_address", ref: "r.source_event", eventId: "r.id::text",
  },
});

function hourlySql(spec) {
  return `
    select date_trunc('hour', ${spec.time}) as hour,
           min(${spec.time}) as period_start,
           max(${spec.time}) as period_end,
           count(*)::int as evidence_count,
           coalesce(sum(${spec.amount}), 0)::text as amount_raw
      from ${spec.from}
     where ${spec.where}
     group by 1`;
}

// $2 / $3: window [start, end); $4: row cap.
function eventSql(spec) {
  return `
    select ${spec.time} as occurred_at,
           (${spec.amount})::text as amount_raw,
           ${spec.tx} as tx_hash,
           ${spec.logIndex} as log_index,
           ${spec.campaign} as campaign_address,
           ${spec.ref} as reference,
           ${spec.eventId} as event_id
      from ${spec.from}
     where ${spec.where}
       and ${spec.time} >= $2 and ${spec.time} < $3
     order by 1 asc, 7 asc
     limit $4`;
}

const mapSpecs = (build) => Object.freeze(Object.fromEntries(Object.entries(LANE_SPECS).map(([k, spec]) => [k, build(spec)])));
export const LANE_QUERIES = Object.freeze({
  ...mapSpecs(hourlySql),
  bonding_excluded: `
    select count(*)::int as n
      from public.reward_events r
     where r.chain_id = $1
       and r.route_kind = 'trade'
       and r.protocol_amount > 0
       and not ${campaignNotHiddenSql("r.chain_id", "r.campaign_address")}`,
  arena_boosts_excluded: `
    select count(*)::int as n
      from public.arena_contest_actions a
      join public.arena_battles b on b.id = a.battle_id and b.chain_id = a.chain_id
     where a.chain_id = $1
       and a.action_type = 'boost'
       and a.confirmed_at is not null
       and a.protocol_native_raw > 0
       and not ${battleNotHiddenSql("b")}`,
  // DBC migrations on a bound quote (USDC, stocks): the row is in quote units,
  // not lamports, so it is not in the SOL lane. Counted for a note.
  dbc_migration_fee_bound_quote: `
    select count(*)::int as n
      from public.reward_events r
     where ${DBC_MIGRATION_WHERE}
       and ${dbcQuoteIsSolSql("r.chain_id", "r.campaign_address", true)}
       and ${campaignNotHiddenSql("r.chain_id", "r.campaign_address")}`,
});
export const EVENT_QUERIES = mapSpecs(eventSql);

/**
 * Every revenue lane of one network, in display order. `core: true` marks the
 * two lanes that existed before this module (bonding curve, UP votes); `vote`
 * marks the lane that needs the UP vote approval check.
 */
export function laneDefinitions(network, { includeCore = false } = {}) {
  const native = { assetSymbol: network.asset, decimals: network.decimals };
  const solana = network.chain === "solana";
  const defs = [];
  if (includeCore) {
    defs.push({ key: "bonding", core: true, id: `bonding-route:${network.chainId}`, lane: "bonding_curve_fee", source: "Bonding-curve trade fee protocol share", ...native, sourceInventoryId: solana ? "sol101-mainnet-protocol-vault" : `${evmPrefix(network)}-treasury-router` });
    defs.push({ key: solana ? "upvotes_solana" : "upvotes_evm", core: true, vote: true, id: `upvotes:${network.chainId}:native`, lane: "upvotes", source: "Paid UP votes 100%", ...native, sourceInventoryId: solana ? "sol101-mainnet-protocol-treasury" : `${evmPrefix(network)}-vote-treasury` });
  }
  defs.push(
    { key: "arena_boosts", lane: "other_approved", source: "Arena boosts 10%", ...native, sourceInventoryId: inventoryId(network, "arena") },
    { key: "arena_entries", lane: "other_approved", source: "Battle entries 5% (stakes, support, tournament buy-ins)", ...native, sourceInventoryId: inventoryId(network, "arena") },
    { key: "sponsorships", lane: "sponsorship", source: "Sponsorships 10% + marketing 20%", ...native, sourceInventoryId: inventoryId(network, "sponsorship") },
    { key: "home_placements", lane: "sponsorship", source: "Home placements (marked paid by admin, off-chain)", assetSymbol: "USD", decimals: USD_CENTS_DECIMALS, sourceInventoryId: "off-chain-sponsorship-applications" },
  );
  defs.push({ key: "import_swaps", lane: "other_approved", source: "Import swaps 0.5%", ...native, sourceInventoryId: inventoryId(network, "importSwap") });
  if (solana) {
    defs.push({ key: "dbc_referral", lane: "other_approved", source: "Meteora DBC referral (20% of Meteora's cut)", ...native, sourceInventoryId: inventoryId(network, "dbcReferral") });
    defs.push({ key: "dbc_migration_fee", lane: "bonding_curve_fee", source: "DBC migration fee (partner share)", ...native, sourceInventoryId: inventoryId(network, "dbcMigration") });
  } else {
    defs.push({ key: "graduation_fee", lane: "bonding_curve_fee", source: "Graduation fee (finalize) protocol share", ...native, sourceInventoryId: inventoryId(network, "finalize") });
  }
  // `chain` goes on every aggregate: the dashboard checks each row belongs to
  // the chain section it came in (it was missing, so every chain section failed).
  return defs.map((d) => ({ ...d, chain: network.chain, id: d.id || `${d.key.replaceAll("_", "-")}:${network.chainId}` }));
}

/**
 * UP votes count only where the whole payment is ours: Solana always (plain
 * transfer to the vote treasury, founder 2026-10-04); BNB / Robinhood when the
 * vote treasury's feeReceiver is the protocol revenue vault (financeVoteRevenue.js).
 */
async function defaultUpvoteApproval(network) {
  if (network.chain === "solana") return { approved: true, reason: null };
  const { readUpvoteFeeReceiverApproval } = await import("./financeVoteRevenue.js");
  const result = await readUpvoteFeeReceiverApproval(network);
  return { approved: Boolean(result?.approved), reason: result?.reason || null, message: result?.message || null };
}

/**
 * The approval from the stored snapshot (finance_snapshots, rebuilt by
 * cron:finance-snapshots), so a revenue read does not wait on the view call.
 * A failed check is not stored: it throws, as before.
 */
export function snapshotUpvoteApproval(db) {
  return (network) => {
    if (network.chain === "solana" || !db || typeof db.query !== "function") return defaultUpvoteApproval(network);
    return snapshotCacheFor(db).get(snapshotKeys.upvoteApproval(network), "upvote-approval", () => defaultUpvoteApproval(network));
  };
}

/** Rebuilds the stored approval now (cron). */
export function refreshUpvoteApprovalSnapshot(db, network) {
  return snapshotCacheFor(db).refresh(snapshotKeys.upvoteApproval(network), "upvote-approval", () => defaultUpvoteApproval(network));
}

const CHAIN_NAMES = Object.freeze({ 101: "Solana", 56: "BNB", 4663: "Robinhood" });

/** Plain note for UP votes left out of revenue; the reason code stays at the end for the logs. */
export function upvoteNote(network, approval) {
  const name = CHAIN_NAMES[network.chainId] || `Chain ${network.chainId}`;
  const why = approval?.message || "the vote treasury could not be checked";
  return `${name} UP votes are left out of revenue: ${why}${approval?.reason ? ` (${approval.reason})` : ""}.`;
}

/**
 * THE revenue lanes of one mainnet: bonding curve, UP votes and the lanes
 * above. /revenue, /summary (admin/finance.js revenueLanes) and the accounting
 * Close / tax / CSV (financeAccountingSources.js) all read this one function.
 *
 * Errors: a missing table drops its lane. The bonding lane is the base figure,
 * so any other bonding error throws (as before); any other lane error is
 * logged and drops only that lane.
 * @returns {Promise<{lanes: object[], excludedEvents: number, notes: string[]}>}
 */
export async function sharedRevenueLanes(db, network, { upvoteApproval = snapshotUpvoteApproval(db), log = console } = {}) {
  const lanes = [];
  const notes = [];
  let excludedEvents = 0;
  // The lane queries are independent: they run a few at a time and are then
  // applied in definition order, with the same rules as one by one.
  const defs = laneDefinitions(network, { includeCore: true });
  const reads = await mapSettled(defs, LANE_QUERY_CONCURRENCY, async (def) => {
    if (def.vote) {
      const approval = await upvoteApproval(network);
      if (!approval?.approved) return { denied: approval };
    }
    const { rows } = await laneQuery(db, def.key, network.chainId);
    return { rows };
  });
  for (const [index, def] of defs.entries()) {
    const read = reads[index];
    if (read.status === "fulfilled") {
      if (read.value.denied !== undefined) { notes.push(upvoteNote(network, read.value.denied)); continue; }
      const lane = laneFromHourlyRows(read.value.rows, def);
      if (lane) lanes.push(lane);
      continue;
    }
    const error = read.reason;
    if (isSchemaMissing(error)) continue;
    if (def.key === "bonding") throw error;
    log.warn?.(`[finance/revenue] ${def.key} lane omitted`, error?.message || error);
    if (def.vote) notes.push(`UP vote revenue on chain ${network.chainId} could not be read (${String(error?.message || error).slice(0, 120)}).`);
  }
  const counts = await mapSettled(["bonding_excluded", "arena_boosts_excluded"], 2, (key) => laneQuery(db, key, network.chainId));
  for (const [index, key] of ["bonding_excluded", "arena_boosts_excluded"].entries()) {
    const read = counts[index];
    if (read.status === "fulfilled") excludedEvents += Number(read.value.rows?.[0]?.n || 0);
    else if (!isSchemaMissing(read.reason)) log.warn?.(`[finance/revenue] ${key} count omitted`, read.reason?.message || read.reason);
  }
  if (network.chain === "solana") {
    const note = await dbcBoundQuoteNote(db, network, log);
    if (note) notes.push(note);
  }
  return { lanes, excludedEvents, notes };
}

/** Note for DBC migrations on a bound quote, which the SOL lane cannot count; null when there are none. */
export async function dbcBoundQuoteNote(db, network, log = console) {
  try {
    const { rows } = await laneQuery(db, "dbc_migration_fee_bound_quote", network.chainId);
    const n = Number(rows?.[0]?.n || 0);
    return n > 0 ? `${n} DBC migration fee${n === 1 ? " is" : "s are"} on a coin with a non-SOL quote; recorded in quote units, so left out of the SOL lane.` : null;
  } catch (error) {
    if (!isSchemaMissing(error)) log.warn?.("[finance/revenue] dbc bound-quote count omitted", error?.message || error);
    return null;
  }
}

const LANE_QUERY_CONCURRENCY = 4;

// On the API pool, one lane query result is shared for 20 s: a weekly or tax
// read asks for the same lanes (full history, one chain) several times in one
// request, and Overview, Revenue and Summary ask together. Other handles
// (tests, scripts) always query.
const LANE_MEMO_MS = 20_000;
const laneMemo = new Map();
function laneQuery(db, key, chainId) {
  if (!db || db !== globalThis.__memewarzone_pool) return db.query(LANE_QUERIES[key], [chainId]);
  const memoKey = `${key}:${chainId}`;
  const hit = laneMemo.get(memoKey);
  if (hit && Date.now() - hit.at < LANE_MEMO_MS) return hit.promise;
  const promise = db.query(LANE_QUERIES[key], [chainId]);
  laneMemo.set(memoKey, { at: Date.now(), promise });
  promise.catch(() => { if (laneMemo.get(memoKey)?.promise === promise) laneMemo.delete(memoKey); });
  return promise;
}

/** Promise.allSettled with at most `limit` running at once; results in input order. */
async function mapSettled(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The lanes added by this module only (no bonding / UP votes). */
export async function extraRevenueLanes(db, network, options = {}) {
  const extraIds = new Set(laneDefinitions(network).map((d) => d.id));
  const all = await sharedRevenueLanes(db, network, { ...options, upvoteApproval: async () => ({ approved: false, reason: "core lane" }) });
  return { lanes: all.lanes.filter((l) => extraIds.has(l.aggregate.id)), excludedEvents: await countArenaExcluded(db, network, options) };
}

async function countArenaExcluded(db, network, { log = console } = {}) {
  try {
    const { rows } = await db.query(LANE_QUERIES.arena_boosts_excluded, [network.chainId]);
    return Number(rows?.[0]?.n || 0);
  } catch (error) {
    if (!isSchemaMissing(error)) log.warn?.("[finance/revenue] arena test-coin count omitted", error?.message || error);
    return 0;
  }
}

/**
 * Per-event rows of every lane of one network for [start, end), for the
 * revenue CSV. Same specs (filters, amounts, test coins) as the hourly lanes.
 * @returns {Promise<{events: object[], notes: string[], truncated: boolean}>}
 */
export async function revenueLaneEvents(db, network, { start, end, maxRowsPerLane, upvoteApproval = snapshotUpvoteApproval(db), log = console } = {}) {
  const events = [];
  const notes = [];
  let truncated = false;
  for (const def of laneDefinitions(network, { includeCore: true })) {
    try {
      if (def.vote) {
        const approval = await upvoteApproval(network);
        if (!approval?.approved) {
          notes.push(upvoteNote(network, approval));
          continue;
        }
      }
      const { rows } = await db.query(EVENT_QUERIES[def.key], [network.chainId, start, end, maxRowsPerLane + 1]);
      if (rows.length > maxRowsPerLane) truncated = true;
      for (const row of rows.slice(0, maxRowsPerLane)) {
        const raw = String(row.amount_raw ?? "0").split(".")[0];
        if (!/^\d+$/.test(raw) || raw === "0") continue;
        events.push({ def, at: row.occurred_at, amountRaw: raw, txHash: row.tx_hash ?? null, logIndex: row.log_index ?? null, campaign: row.campaign_address ?? null, reference: row.reference ?? null, eventId: row.event_id ?? null });
      }
    } catch (error) {
      if (isSchemaMissing(error)) continue;
      if (def.key === "bonding") throw error;
      log.warn?.(`[finance/revenue-events] ${def.key} omitted`, error?.message || error);
      notes.push(`${def.source} on chain ${network.chainId} could not be read.`);
    }
  }
  return { events, notes, truncated };
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
