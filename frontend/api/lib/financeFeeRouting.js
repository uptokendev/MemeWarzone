// Finance fee-routing read model: where each fee goes, what every destination
// holds now, and how much the database says was routed there in a period.
//
// Strictly read-only. Balances come from JSON-RPC reads (eth_getBalance,
// eth_call, getBalance, getAccountInfo, getTokenAccountsByOwner); inflows from
// SELECT aggregates on existing tables. No transaction is built, signed or
// sent, and no key is loaded. Any read that fails is returned as
// status "unknown" with no amount: never a zero.

import { getRpcUrls } from "./getServerReadProvider.js";
import {
  decodeAddressWord,
  readEvmCall,
  readEvmNative,
  readEvmToken,
  readSolanaAccountData,
  readSolanaLamports,
  readSolanaTokenByOwner,
} from "./financeFeeRoutingReaders.js";
import {
  SOLANA_DEPLOYER,
  SOLANA_DEVNET_DEPLOYER,
  SOLANA_SQUADS_VAULT,
  SOLANA_ROUTE_OPERATOR,
  WSOL_MINT,
  decodeArenaConfig,
  decodeArenaMoneyV2,
  decodeRouteState,
  solanaFeeRoutingRegistry,
} from "./financeFeeRoutingSolana.js";
import { EVM_FEE_ROUTING_CHAINS, evmFeeRoutingRegistry, evmGetterSelector } from "./financeFeeRoutingEvm.js";
import { destinationOwnership } from "./financeFeeRoutingOwnership.js";
import { buildTotals, defaultPriceService, priceAssetFor } from "./financePrices.js";
import { notPublicHiddenCampaignSql } from "./publicHiddenSql.js";

export const FEE_ROUTING_SCHEMA = "finance-fee-routing-v1";
const DEFAULT_DAYS = 30;
const MAX_DAYS = 3650;
const CACHE_TTL_MS = 60_000;

const cache = new Map();

export function feeRoutingDays(value) {
  const days = Number.parseInt(String(value ?? DEFAULT_DAYS), 10);
  if (!Number.isFinite(days) || days < 1) return DEFAULT_DAYS;
  return Math.min(days, MAX_DAYS);
}

/** Finance covers the mainnets only (2026-10-04): nothing is earned on a testnet. */
export const FEE_ROUTING_MAINNET_CHAIN_IDS = Object.freeze([101, 56, 4663]);

const SOLANA_MAINNET_FEE_NETWORK = Object.freeze({ chainId: 101, chain: "solana", environment: "production", cluster: "mainnet-beta", nativeSymbol: "SOL", nativeDecimals: 9 });

/**
 * Network for the fee-routing view: BNB 56, Robinhood 4663 or Solana mainnet-beta
 * (production DB, live API). Testnets and devnet are refused rather than guessed.
 */
export function feeRoutingNetwork(query = {}) {
  const chainId = Number(query.chainId);
  if (chainId === 56 || chainId === 4663) return { chainId, ...EVM_FEE_ROUTING_CHAINS[chainId] };
  if (chainId !== 101) return null;
  const environment = String(query.environment || "").trim().toLowerCase();
  const cluster = String(query.solanaCluster ?? query.cluster ?? "").trim().toLowerCase().replace(/^solana-/, "");
  if (environment !== "production" || cluster !== "mainnet-beta") return null;
  return { ...SOLANA_MAINNET_FEE_NETWORK };
}

/** chainId=all: the three mainnets, in display order. */
export function feeRoutingAllNetworks() {
  return [{ ...SOLANA_MAINNET_FEE_NETWORK }, { chainId: 56, ...EVM_FEE_ROUTING_CHAINS[56] }, { chainId: 4663, ...EVM_FEE_ROUTING_CHAINS[4663] }];
}

export function atomicToDecimal(raw, decimals) {
  const text = String(raw ?? "");
  if (!/^\d+$/.test(text)) return null;
  if (decimals === 0) return text.replace(/^0+(?=\d)/, "");
  const padded = text.replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function okAmount({ asset, decimals, raw, source, asOf, extra = {} }) {
  return { asset, decimals, raw: String(raw), amount: atomicToDecimal(raw, decimals), status: "ok", source, asOf, ...extra };
}

function unknownAmount({ asset, decimals, source, error, status = "unknown", extra = {} }) {
  return { asset, decimals, raw: null, amount: null, status, source, asOf: null, error: String(error || "Source unavailable.").slice(0, 300), ...extra };
}

export function solanaRpcUrls(env) {
  const urls = [];
  for (const name of ["SOLANA_MAINNET_RPC_HTTP", "SOLANA_MAINNET_RPC_URL", "SOLANA_RPC_URL", "SOLANA_RPC_HTTP"]) {
    for (const part of String(env[name] || "").split(",")) {
      const url = part.trim();
      if (url && !/devnet|testnet/i.test(url) && !urls.includes(url)) urls.push(url);
    }
  }
  urls.push("https://api.mainnet-beta.solana.com");
  return [...new Set(urls)];
}

// --------------------------------------------------------------------------
// Balances

async function solanaBalances(destination, ctx) {
  if (!destination.address) {
    return (destination.assets || []).map((asset) => unknownAmount({
      asset: asset === "wsol" ? "WSOL" : "SOL", decimals: 9, source: "env",
      status: "not_configured", error: `${destination.missingEnv || "Address"} is not set on this API.`,
    }));
  }
  const out = [];
  for (const asset of destination.assets || []) {
    const symbol = asset === "wsol" ? "WSOL" : "SOL";
    try {
      const read = asset === "wsol"
        ? await ctx.readers.readSolanaTokenByOwner({ urls: ctx.urls, owner: destination.address, mint: WSOL_MINT, fetchImpl: ctx.fetchImpl })
        : await ctx.readers.readSolanaLamports({ urls: ctx.urls, address: destination.address, fetchImpl: ctx.fetchImpl });
      out.push(okAmount({ asset: symbol, decimals: 9, raw: read.raw, source: `rpc:${read.rpc}${read.slot ? ` slot ${read.slot}` : ""}`, asOf: ctx.now() }));
    } catch (error) {
      out.push(unknownAmount({ asset: symbol, decimals: 9, source: "rpc", error: error?.message }));
    }
  }
  return out;
}

async function evmBalances(destination, ctx, network) {
  if (!destination.address) {
    return (destination.assets || []).map((asset) => unknownAmount({
      asset: asset === "native" ? network.nativeSymbol : asset, decimals: 18, source: "registry",
      status: "not_configured", error: destination.missingNote || "No address recorded for this chain.",
    }));
  }
  const out = [];
  for (const asset of destination.assets || []) {
    const token = asset === "native" ? null : network.tokens?.[asset];
    const symbol = asset === "native" ? network.nativeSymbol : asset;
    try {
      if (asset !== "native" && !token) throw new Error(`No ${asset} address recorded for chain ${network.chainId}.`);
      const read = token
        ? await ctx.readers.readEvmToken({ urls: ctx.urls, token: token.address, holder: destination.address, fetchImpl: ctx.fetchImpl })
        : await ctx.readers.readEvmNative({ urls: ctx.urls, address: destination.address, fetchImpl: ctx.fetchImpl });
      out.push(okAmount({ asset: symbol, decimals: token?.decimals ?? 18, raw: read.raw, source: `rpc:${read.rpc}`, asOf: ctx.now() }));
    } catch (error) {
      out.push(unknownAmount({ asset: symbol, decimals: token?.decimals ?? 18, source: "rpc", error: error?.message }));
    }
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// --------------------------------------------------------------------------
// Inflows (DB aggregates over the period)

function sinceIso(days, now) {
  return new Date(Date.parse(now) - days * 86_400_000).toISOString();
}

async function safeQuery(db, sql, params) {
  try {
    const { rows } = await db.query(sql, params);
    return { rows, error: null };
  } catch (error) {
    return { rows: null, error: error?.code === "42P01" || error?.code === "42703" ? `Table or column missing (${error.code}).` : error?.message || "Query failed." };
  }
}

/**
 * Sums hourly rows (one per key and hour) into one row per key, keeping the
 * hourly amounts per column so each can be valued at the price of its hour.
 * Rows without an `hour` column are valued at spot later.
 */
export function rollupHourly(rows, columns, keyColumn = null) {
  const out = new Map();
  for (const row of rows || []) {
    const key = keyColumn ? row?.[keyColumn] : "_";
    const acc = out.get(key) || { n: 0, __buckets: {} };
    if (keyColumn) acc[keyColumn] = key;
    acc.n += Number(row?.n ?? 0);
    for (const column of columns) {
      const text = row?.[column] == null ? "0" : String(row[column]).split(".")[0];
      if (!/^\d+$/.test(text) || acc[column] === "invalid") { acc[column] = "invalid"; continue; }
      acc[column] = (BigInt(acc[column] || "0") + BigInt(text)).toString();
      (acc.__buckets[column] ||= []).push({ hour: row?.hour ?? null, raw: text });
    }
    out.set(key, acc);
  }
  return out;
}

function inflowFrom(row, column, { asset, decimals, source, asOf, note, countColumn = "n" }) {
  const raw = row?.[column];
  const text = raw == null ? "0" : String(raw).split(".")[0];
  if (!/^\d+$/.test(text)) return unknownAmount({ asset, decimals, source, error: "Non-integer aggregate.", extra: { eventCount: null } });
  const amount = okAmount({ asset, decimals, raw: text, source, asOf, extra: { eventCount: Number(row?.[countColumn] ?? 0), ...(note ? { note } : {}) } });
  // Internal: removed by attachUsd before the payload leaves the API.
  Object.defineProperty(amount, "buckets", { value: row?.__buckets?.[column] || [{ hour: null, raw: text }], enumerable: false });
  return amount;
}

function inflowError(error, { asset, decimals, source }) {
  return unknownAmount({ asset, decimals, source, error, extra: { eventCount: null } });
}

/** Solana inflows. Keys are destination ids. */
export async function solanaInflows(db, { days, now }) {
  const since = sinceIso(days, now);
  const out = {};
  const add = (id, value) => { (out[id] ||= []).push(value); };
  const base = { asset: "SOL", decimals: 9, asOf: now };

  // reward_events: launchpad FeeSlices (accrued to escrow / routed at finalize)
  // and DBC collector routing (EvtSwap2). raw_amount = the whole fee.
  const reSource = "db:reward_events";
  const re = await safeQuery(db, `
    select case when source_event = 'EvtSwap2' then 'dbc' else 'launchpad' end as lane,
           date_trunc('hour', r.occurred_at) as hour,
           count(*)::int as n,
           coalesce(sum(nullif(metadata->>'weeklyLeagueLamports', '')::numeric), 0)::text as weekly,
           coalesce(sum(nullif(metadata->>'monthlyLeagueLamports', '')::numeric), 0)::text as monthly,
           coalesce(sum(league_amount), 0)::text as league,
           coalesce(sum(recruiter_amount), 0)::text as recruiter,
           coalesce(sum(airdrop_amount), 0)::text as airdrop,
           coalesce(sum(squad_amount), 0)::text as squad,
           coalesce(sum(protocol_amount), 0)::text as protocol,
           coalesce(sum(nullif(metadata->>'creatorLamports', '')::numeric), 0)::text as creator,
           coalesce(sum(raw_amount), 0)::text as fee
      from public.reward_events r
     where r.chain_id = 101 and r.occurred_at >= $1
       and ${notPublicHiddenCampaignSql("r")}
     group by 1, 2`, [since]);
  if (re.error) {
    for (const id of ["league_weekly", "league_monthly", "recruiter_vault", "airdrop_vault", "squad_vault", "protocol_vault", "creator_fee_vaults"]) {
      add(id, inflowError(re.error, { ...base, source: reSource }));
    }
  } else {
    const lanes = rollupHourly(re.rows, ["weekly", "monthly", "league", "recruiter", "airdrop", "squad", "protocol", "creator", "fee"], "lane");
    for (const lane of ["launchpad", "dbc"]) {
      const row = lanes.get(lane) || { n: 0 };
      const note = lane === "launchpad"
        ? "Launchpad trade + graduation slices (FeeSlicesAccrued counts when escrowed; it reaches the vault on flush)"
        : "Meteora DBC slices routed by the collector";
      const opts = { ...base, source: `${reSource} (${lane})`, note };
      add("league_weekly", inflowFrom(row, "weekly", opts));
      add("league_monthly", inflowFrom(row, "monthly", opts));
      add("recruiter_vault", inflowFrom(row, "recruiter", opts));
      add("airdrop_vault", inflowFrom(row, "airdrop", opts));
      add("squad_vault", inflowFrom(row, "squad", opts));
      add("protocol_vault", inflowFrom(row, "protocol", opts));
      if (lane === "launchpad") add("creator_fee_vaults", inflowFrom(row, "creator", opts));
    }
  }

  const mwl = await safeQuery(db, `
    select date_trunc('hour', created_at) as hour, count(*)::int as n, coalesce(sum(gross_raw), 0)::text as amount
      from public.arena_league_share_ledger
     where chain_id = 101 and created_at >= $1
     group by 1`, [since]);
  add("mwl_vault", mwl.error ? inflowError(mwl.error, { ...base, source: "db:arena_league_share_ledger" })
    : inflowFrom(rollupHourly(mwl.rows, ["amount"]).get("_") || { n: 0 }, "amount", { ...base, source: "db:arena_league_share_ledger", note: "Arena league shares recorded by the crank before it moves them" }));

  const votes = await safeQuery(db, `
    select date_trunc('hour', v.block_timestamp) as hour, count(*)::int as n, coalesce(sum(v.amount_raw), 0)::text as amount
      from public.votes_confirmed v
     where v.chain_id = 101 and v.status = 'confirmed'
       and v.asset_address = '11111111111111111111111111111111'
       and v.block_timestamp >= $1
       and ${notPublicHiddenCampaignSql("v")}
     group by 1`, [since]);
  add("vote_treasury", votes.error ? inflowError(votes.error, { ...base, source: "db:votes_confirmed" })
    : inflowFrom(rollupHourly(votes.rows, ["amount"]).get("_") || { n: 0 }, "amount", { ...base, source: "db:votes_confirmed", note: "Confirmed native UP votes" }));

  const dbc = await safeQuery(db, `
    select date_trunc('hour', created_at) as hour,
           count(*)::int as n,
           coalesce(sum(collector_amount), 0)::text as collector,
           coalesce(sum(referral_fee), 0)::text as referral
      from public.dbc_fee_accruals
     where created_at >= $1
     group by 1`, [since]);
  if (dbc.error) {
    add("dbc_fee_collector", inflowError(dbc.error, { ...base, source: "db:dbc_fee_accruals" }));
    add("dbc_referral", inflowError(dbc.error, { ...base, source: "db:dbc_fee_accruals" }));
  } else {
    const dbcRow = rollupHourly(dbc.rows, ["collector", "referral"]).get("_") || { n: 0 };
    add("dbc_fee_collector", inflowFrom(dbcRow, "collector", { ...base, source: "db:dbc_fee_accruals", note: "Partner fee claimed by the collector before re-split" }));
    add("dbc_referral", inflowFrom(dbcRow, "referral", { ...base, source: "db:dbc_fee_accruals", note: "Referral fee named on our swaps" }));
  }

  const escrow = await safeQuery(db, `
    select e.event_kind, date_trunc('hour', e.created_at) as hour, count(*)::int as n, coalesce(sum(e.protocol_lamports), 0)::text as protocol, coalesce(sum(e.total_lamports), 0)::text as total
      from public.solana_fee_escrow_events e
     where e.chain_id = 101 and e.created_at >= $1 and e.event_kind in ('FeeSlicesAccrued', 'FeeEscrowFlushed')
       and ${notPublicHiddenCampaignSql("e")}
     group by 1, 2`, [since]);
  const flushed = escrow.rows ? rollupHourly(escrow.rows, ["protocol", "total"], "event_kind").get("FeeEscrowFlushed") : null;
  return {
    inflows: out,
    extras: {
      escrowFlushed: escrow.error ? inflowError(escrow.error, { ...base, source: "db:solana_fee_escrow_events" })
        : inflowFrom(flushed || { n: 0 }, "total", { ...base, source: "db:solana_fee_escrow_events (FeeEscrowFlushed)", note: "Six slices moved from campaign escrows into the vaults" }),
    },
  };
}

/** EVM inflows from reward_events / votes / arena tables. Empty tables return ok zero (with eventCount 0). */
export async function evmInflows(db, network, registry, { days, now }) {
  const since = sinceIso(days, now);
  const out = {};
  const add = (id, value) => { if (id) (out[id] ||= []).push(value); };
  const base = { asset: network.nativeSymbol, decimals: 18, asOf: now };
  const ids = registry.inflowDestinations || {};

  const re = await safeQuery(db, `
    select date_trunc('hour', r.occurred_at) as hour,
           count(*)::int as n,
           coalesce(sum(floor(league_amount * 3000 / 10000)), 0)::text as weekly,
           coalesce(sum(league_amount - floor(league_amount * 3000 / 10000)), 0)::text as monthly,
           coalesce(sum(recruiter_amount), 0)::text as recruiter,
           coalesce(sum(airdrop_amount), 0)::text as airdrop,
           coalesce(sum(squad_amount), 0)::text as squad,
           coalesce(sum(protocol_amount), 0)::text as protocol
      from public.reward_events r
     where r.chain_id = $1 and r.occurred_at >= $2
       and ${notPublicHiddenCampaignSql("r")}
     group by 1`, [network.chainId, since]);
  const reRow = re.error ? null : rollupHourly(re.rows, ["weekly", "monthly", "recruiter", "airdrop", "squad", "protocol"]).get("_") || { n: 0 };
  const reOpts = { ...base, source: "db:reward_events", note: "Treasury router RouteExecuted events" };
  const columns = [
    ["weekly", ids.weekly, "League slice x weeklyLeagueBps 3000 (the router's split), derived per event"],
    ["monthly", ids.monthly, "League slice minus the weekly part, derived per event"],
    ["recruiter", ids.recruiter, null],
    ["airdrop", ids.airdrop, "Airdrop pool (unlinked recruiter slice)"],
    ["squad", ids.squad, "Squad pool"],
    ["protocol", ids.protocol, "Trade + finalize protocol slice (UP votes and sponsorships are listed separately)"],
  ];
  for (const [column, id, note] of columns) {
    if (!id) continue;
    add(id, re.error ? inflowError(re.error, reOpts) : inflowFrom(reRow, column, { ...reOpts, ...(note ? { note } : {}) }));
  }
  if (ids.creator) {
    add(ids.creator, inflowError("reward_events has no creator column; the indexer drops RouteExecuted.creatorAmount (realtime-indexer/src/indexer.ts:1273-1289).", reOpts));
  }
  const routeEventCount = re.error ? null : Number(reRow?.n || 0);

  if (ids.votes) {
    const votes = await safeQuery(db, `
      select date_trunc('hour', v.block_timestamp) as hour, count(*)::int as n, coalesce(sum(v.amount_raw), 0)::text as amount
        from public.votes_confirmed v
       where v.chain_id = $1 and v.status = 'confirmed'
         and v.asset_address = '0x0000000000000000000000000000000000000000'
         and v.block_timestamp >= $2
         and ${notPublicHiddenCampaignSql("v")}
       group by 1`, [network.chainId, since]);
    add(ids.votes, votes.error ? inflowError(votes.error, { ...base, source: "db:votes_confirmed" })
      : inflowFrom(rollupHourly(votes.rows, ["amount"]).get("_") || { n: 0 }, "amount", { ...base, source: "db:votes_confirmed", note: "Confirmed native UP votes" }));
  }

  if (ids.mwl) {
    const mwl = await safeQuery(db, `
      select date_trunc('hour', created_at) as hour, count(*)::int as n, coalesce(sum(gross_raw), 0)::text as amount
        from public.arena_league_share_ledger
       where chain_id = $1 and created_at >= $2
       group by 1`, [network.chainId, since]);
    add(ids.mwl, mwl.error ? inflowError(mwl.error, { ...base, source: "db:arena_league_share_ledger" })
      : inflowFrom(rollupHourly(mwl.rows, ["amount"]).get("_") || { n: 0 }, "amount", { ...base, source: "db:arena_league_share_ledger", note: "Arena league shares claimed by the crank" }));
  }

  return { inflows: out, extras: { routeEventCount } };
}

// --------------------------------------------------------------------------
// Wiring checks (live chain state vs registry)

function same(a, b, evm) {
  if (!a || !b) return false;
  return evm ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function solanaWiring(ctx, registry) {
  const checks = [];
  const alerts = [];
  const { pda } = registry;
  const read = async (label, address, decode) => {
    try {
      const account = await ctx.readers.readSolanaAccountData({ urls: ctx.urls, address, fetchImpl: ctx.fetchImpl });
      return { value: decode(account.data), source: `rpc:${account.rpc}${account.slot ? ` slot ${account.slot}` : ""}` };
    } catch (error) {
      return { error: `${label}: ${error?.message || "read failed"}` };
    }
  };
  const push = (id, label, expected, actual, source, error) => checks.push({
    id, label, expected, actual: actual ?? null,
    status: error ? "unknown" : same(expected, actual, false) ? "match" : "mismatch",
    source: source || "rpc", ...(error ? { error } : {}),
  });

  const route = await read("route_state", pda.routeState, decodeRouteState);
  push("route_operator", "route_state.operator (protocol fill wallet)", SOLANA_ROUTE_OPERATOR, route.value?.operator, route.source, route.error);
  push("route_overflow", "route_state.overflow_treasury", SOLANA_SQUADS_VAULT, route.value?.overflowTreasury, route.source, route.error);
  let routeInfo = null;
  if (route.value) {
    routeInfo = route.value;
    checks.push({
      id: "route_cap_fill", label: "Operator cap filled (USD micros)",
      expected: `cap ${route.value.capUsdMicros}`, actual: `filled ${route.value.filledUsdMicros} at SOL/USD micros ${route.value.nativeUsdMicros}`,
      status: "match", source: route.source,
    });
    if (route.value.authority === SOLANA_DEPLOYER) {
      alerts.push({ level: "info", message: "route_state, arena_config and rewards_config authority is the deployer 9YN7…. It receives no fees, but it can re-point the operator, overflow and arena receivers." });
    }
    if (route.value.operator === SOLANA_DEPLOYER || route.value.overflowTreasury === SOLANA_DEPLOYER) {
      alerts.push({ level: "critical", message: "route_state pays protocol revenue to the deployer 9YN7…, which must never hold user money." });
    }
  }

  const arena = await read("arena_config", pda.arenaConfig, decodeArenaConfig);
  push("arena_protocol", "arena_config.protocol_receiver", pda.protocol, arena.value?.protocolReceiver, arena.source, arena.error);
  push("arena_mwl", "arena_config.mwl_receiver", pda.mwl, arena.value?.mwlReceiver, arena.source, arena.error);

  const money = await read("arena_money_config_v2", pda.arenaMoneyV2, decodeArenaMoneyV2);
  push("sponsor_protocol", "arena_money_config_v2.protocol_receiver", pda.protocol, money.value?.protocolReceiver, money.source, money.error);
  push("sponsor_marketing", "arena_money_config_v2.marketing_receiver", pda.protocol, money.value?.marketingReceiver, money.source, money.error);

  for (const value of [arena.value?.protocolReceiver, arena.value?.mwlReceiver, money.value?.protocolReceiver, money.value?.marketingReceiver]) {
    if (value === SOLANA_DEPLOYER) {
      alerts.push({ level: "critical", message: "An arena receiver on chain is the deployer 9YN7…, which must never hold user money." });
      break;
    }
  }
  return { checks, alerts, routeInfo };
}

async function evmWiring(ctx, registry) {
  const checks = [];
  const alerts = [];
  for (const spec of registry.wiring || []) {
    const expected = spec.expected;
    try {
      const call = await ctx.readers.readEvmCall({ urls: ctx.urls, to: spec.contract, data: evmGetterSelector(spec.getter), fetchImpl: ctx.fetchImpl });
      const actual = decodeAddressWord(call.hex);
      const status = same(expected, actual, true) ? "match" : "mismatch";
      checks.push({ id: spec.id, label: spec.label, expected, actual, status, source: `rpc:${call.rpc} ${spec.getter}()` });
      if (status === "mismatch") {
        alerts.push({ level: "warning", message: `${spec.label} reads ${actual} on chain; the deployment record says ${expected}.` });
      }
      if (registry.deployer && same(actual, registry.deployer, true)) {
        alerts.push({ level: "critical", message: `${spec.label} pays the deployer ${registry.deployer}, which must never hold user money.` });
      }
    } catch (error) {
      checks.push({ id: spec.id, label: spec.label, expected, actual: null, status: "unknown", source: `rpc ${spec.getter}()`, error: String(error?.message || "read failed").slice(0, 300) });
    }
  }
  return { checks, alerts };
}

/** Testnet registries name a router getter instead of an address; read it. */
async function resolveRouterDestinations(registry, ctx) {
  for (const destination of registry.destinations) {
    if (destination.address || !destination.resolveFrom) continue;
    try {
      const call = await ctx.readers.readEvmCall({
        urls: ctx.urls,
        to: destination.resolveFrom.contract,
        data: evmGetterSelector(destination.resolveFrom.getter),
        fetchImpl: ctx.fetchImpl,
      });
      const address = decodeAddressWord(call.hex);
      if (!/^0x0{40}$/i.test(address)) destination.address = address;
      else destination.missingNote = `${destination.resolveFrom.getter}() is unset on the router.`;
    } catch (error) {
      destination.missingNote = `Could not read ${destination.resolveFrom.getter}() from the router: ${error?.message || "rpc error"}`;
    }
  }
}

// --------------------------------------------------------------------------

function publicDestination(destination, balances, inflows, chain) {
  return {
    id: destination.id,
    label: destination.label,
    kind: destination.kind,
    address: destination.address || null,
    custody: destination.custody || "",
    role: destination.role || "",
    citation: destination.citation || "",
    flags: destination.flags || [],
    ...destinationOwnership(chain, destination),
    balances,
    inflows: inflows || [],
  };
}

function staticAlerts(network, registry, env) {
  const alerts = [...(registry.alerts || [])];
  if (network.chain === "solana") {
    const lp = registry.destinations.find((d) => d.id === "lp_protocol_treasury");
    if (!lp?.address) {
      alerts.push({ level: "warning", message: "The LP-fee protocol treasury is unknown: FINANCE_SOLANA_LP_PROTOCOL_TREASURY_ADDRESS is not set on this API and the indexer did not report its protocolTreasury. The indexer's 20% LP share goes to SOLANA_PROTOCOL_TREASURY_ADDRESS, falling back to SOLANA_VOTE_TREASURY_ADDRESS and then to devnet key HuKfoF; the manual collect route does not refuse when it is unset." });
    } else if (lp.address === SOLANA_DEVNET_DEPLOYER) {
      alerts.push({ level: "critical", message: "The LP-fee protocol treasury is the devnet key HuKfoF." });
    } else if (lp.address === SOLANA_DEPLOYER) {
      alerts.push({ level: "critical", message: "The LP-fee protocol treasury is the deployer 9YN7…, which must never hold user money." });
    }
    for (const d of registry.destinations) {
      if (!d.flags?.includes("watch") && d.address === SOLANA_DEPLOYER) {
        alerts.push({ level: "critical", message: `${d.label} is configured as the deployer 9YN7…, which must never hold user money.` });
      }
    }
  }
  void env;
  return alerts;
}

// --------------------------------------------------------------------------
// USD. Balances at spot; inflows at the price of the hour each event happened
// in (financePrices.js). A missing price is null, never 0.

async function usdFor(amount, priceService, { events }) {
  if (amount.status !== "ok" || amount.amount == null || !priceAssetFor(amount.asset)) {
    return { amountUsd: null, priceUsd: null, priceSource: null, priceAt: null, priceBasis: null };
  }
  return events
    ? priceService.valueEvents(amount.asset, amount.buckets || [{ hour: null, raw: amount.raw }], amount.decimals)
    : priceService.valueAtSpot(amount.asset, amount.amount);
}

export async function attachUsd(destinations, transit, priceService) {
  const jobs = [];
  for (const d of destinations) {
    for (const b of d.balances) jobs.push(usdFor(b, priceService, { events: false }).then((usd) => Object.assign(b, usd)));
    for (const i of d.inflows) jobs.push(usdFor(i, priceService, { events: true }).then((usd) => Object.assign(i, usd)));
  }
  if (transit) jobs.push(usdFor(transit, priceService, { events: true }).then((usd) => Object.assign(transit, usd)));
  await Promise.all(jobs);
}

/**
 * Totals for the page. Holdings: every destination except watch-only wallets,
 * each address and asset once. Ours: the subset of holdings classified
 * ownership "ours" (financeFeeRoutingOwnership.js); mixed balances are not in
 * it. Inflows: every routed amount except the DBC collector, whose claim is
 * re-split into the vault slices already counted.
 */
export function feeRoutingTotals(network, destinations) {
  const holdings = [];
  const ours = [];
  const inflows = [];
  const seen = new Set();
  for (const d of destinations) {
    if (!d.flags.includes("watch")) {
      for (const b of d.balances) {
        const key = `${String(d.address || d.id).toLowerCase()}:${b.asset}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = { chainId: network.chainId, chain: network.chain, asset: b.asset, amount: b.status === "ok" ? b.amount : null, amountUsd: b.amountUsd ?? null };
        holdings.push(entry);
        if (d.ownership === "ours") ours.push(entry);
      }
    }
    if (d.id === "dbc_fee_collector") continue;
    for (const i of d.inflows) {
      inflows.push({ chainId: network.chainId, chain: network.chain, asset: i.asset, amount: i.status === "ok" ? i.amount : null, amountUsd: i.amountUsd ?? null });
    }
  }
  return {
    holdings: buildTotals(holdings, { seed: [network] }),
    ours: buildTotals(ours, { seed: [network] }),
    inflows: buildTotals(inflows, { seed: [network] }),
  };
}

function indexerBase(env) {
  return String(env.INDEXER_API_BASE_URL || env.INDEXER_BASE_URL || env.RAILWAY_INDEXER_URL || env.VITE_TOKEN_API_BASE || env.VITE_REALTIME_API_BASE || "").trim().replace(/\/+$/, "");
}

/**
 * Where the indexer sends the Solana 20% LP-fee share: `protocolTreasury` of
 * its /api/dashboard/lp-fees read (realtime-indexer/src/lpFeesRoutes.ts). Used
 * only when the API has no FINANCE_SOLANA_LP_PROTOCOL_TREASURY_ADDRESS, so the
 * map needs no extra env. "" when the indexer is not configured or not reachable.
 */
export async function readIndexerLpTreasury({ env = process.env, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const base = indexerBase(env);
  if (!base) return "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/api/dashboard/lp-fees?chainId=101&environment=production&solanaCluster=mainnet-beta&limit=1`, { headers: { Accept: "application/json" }, signal: controller.signal });
    const payload = await response.json().catch(() => null);
    return response.ok && typeof payload?.protocolTreasury === "string" ? payload.protocolTreasury.trim() : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export async function buildFeeRouting({ network, days, db, env = process.env, fetchImpl = fetch, readers, prices, now = () => new Date().toISOString(), lpTreasuryReader = readIndexerLpTreasury }) {
  const generatedAt = now();
  const r = readers || { readEvmNative, readEvmToken, readEvmCall, readSolanaLamports, readSolanaTokenByOwner, readSolanaAccountData };
  const solana = network.chain === "solana";
  const indexerLpTreasury = solana ? await lpTreasuryReader({ env }) : "";
  const registry = solana ? solanaFeeRoutingRegistry(env, { indexerLpTreasury }) : evmFeeRoutingRegistry(network.chainId);
  const ctx = { urls: solana ? solanaRpcUrls(env) : getRpcUrls(network.chainId), fetchImpl, readers: r, now };

  if (!solana) await resolveRouterDestinations(registry, ctx);

  const [balances, inflowResult, wiring] = await Promise.all([
    mapLimit(registry.destinations, 4, (d) => (solana ? solanaBalances(d, ctx) : evmBalances(d, ctx, network))),
    solana ? solanaInflows(db, { days, now: generatedAt }) : evmInflows(db, network, registry, { days, now: generatedAt }),
    solana ? solanaWiring(ctx, registry) : evmWiring(ctx, registry),
  ]);

  const destinations = registry.destinations.map((d, i) => publicDestination(d, balances[i], inflowResult.inflows[d.id], network.chain));
  const priceService = prices || defaultPriceService();
  await attachUsd(destinations, inflowResult.extras?.escrowFlushed, priceService);
  const alerts = [...staticAlerts(network, registry, env), ...wiring.alerts];

  if (!solana && inflowResult.extras?.routeEventCount === 0 && network.environment === "mainnet") {
    const funded = destinations.some((d) => ["weekly_league", "monthly_league", "recruiter_vault", "creator_vault_v2"].includes(d.id)
      && d.balances.some((b) => b.status === "ok" && b.asset === network.nativeSymbol && b.raw !== "0"));
    alerts.push({ level: funded ? "warning" : "info", message: (funded ? "Trade-fee vaults hold money but the database has no router events for this chain, so routed fees are not being recorded (recruiter credit reads the same table). " : "") + `No treasury-router events are stored for chain ${network.chainId} in this period. The indexer scans the gen-6 TreasuryRouterV4 only when TREASURY_ROUTERS_EXTRA_${network.chainId} lists it (realtime-indexer/src/indexer.ts:1182-1188), so zero may mean "not indexed", not "no fees". Compare with the vault balances.` });
  }

  // A watch-only wallet holding money is worth seeing; it is not proof of a fee path.
  for (const d of destinations) {
    if (!d.flags.includes("watch")) continue;
    const held = d.balances.some((b) => b.status === "ok" && b.raw !== "0");
    if (held) alerts.push({ level: "info", message: `${d.label} holds a balance (${d.balances.filter((b) => b.status === "ok").map((b) => `${b.amount} ${b.asset}`).join(", ")}). No fee path in code routes there; check what it is.` });
  }

  return {
    schemaVersion: FEE_ROUTING_SCHEMA,
    generatedAt,
    source: "dashboard-api",
    network: {
      chainId: network.chainId,
      chain: network.chain,
      environment: network.environment,
      ...(network.cluster ? { cluster: network.cluster } : {}),
      nativeSymbol: network.nativeSymbol,
    },
    period: { days, from: sinceIso(days, generatedAt), to: generatedAt },
    destinations,
    flows: registry.flows,
    wiring: wiring.checks,
    alerts,
    ...(inflowResult.extras?.escrowFlushed ? { transit: { escrowFlushed: inflowResult.extras.escrowFlushed } } : {}),
    totals: feeRoutingTotals(network, destinations),
    prices: await priceService.spotTable([priceAssetFor(network.nativeSymbol)]),
    testCoinsExcluded: true,
    testCoinsNote: "Router events, UP votes and escrow events on test coins (campaigns hidden from public listings) are left out. The MWL ledger and DBC accruals carry no campaign, so they are shown in full. Balances are what the chain holds.",
  };
}

export async function cachedFeeRouting(args) {
  const key = `${args.network.chainId}:${args.network.cluster || ""}:${args.days}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await buildFeeRouting(args);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function clearFeeRoutingCache() {
  cache.clear();
}
