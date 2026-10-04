// Read-only inputs for the accounting pages: revenue per month (the very lanes
// of /api/admin/finance/revenue and /summary, financeRevenueLanes.js: bonding
// curve, UP votes, arena boosts / entries, sponsorships, Home placements, DBC
// referral, EVM graduation; hidden test coins left out, each hour valued at
// that hour's price), revenue events for the CSV export, and the
// fee-routing "Ours" / held balances. Nothing here writes.

import { pool } from "../../server/db.js";
import { normalizeSolanaCluster } from "../../shared/solanaCurrentAuthority.mjs";
import { atomicToDecimal, cachedFeeRouting, feeRoutingAllNetworks } from "./financeFeeRouting.js";
import { readNativeUpvoteRevenue } from "./financeVoteRevenue.js";
import { mergeTotals, priceAssetFor } from "./financePrices.js";
import { laneDecimals, revenueLaneEvents, sharedRevenueLanes } from "./financeRevenueLanes.js";
import { notPublicHiddenCampaignSql } from "./publicHiddenSql.js";
import { addMonths, monthOf, roundUsd } from "./financeAccountingCosts.js";

const HOUR_MS = 3_600_000;
export const MAX_EXPORT_ROWS_PER_LANE = 20000;

/** The mainnets, as accounting uses them. */
export function accountingNetworks() {
  return feeRoutingAllNetworks().map((n) => ({ ...n, asset: n.nativeSymbol, decimals: n.nativeDecimals }));
}

// Same rule as finance.js: on the test API chain 101 rows are Solana devnet.
export function solanaRowsAreMainnet(network, env = process.env) {
  return network.chain !== "solana" || normalizeSolanaCluster(env.SOLANA_CLUSTER || env.VITE_SOLANA_CLUSTER || "mainnet-beta") === "mainnet-beta";
}

function windowBounds(fromMonth, toMonth) {
  return { start: `${fromMonth}-01T00:00:00.000Z`, end: `${addMonths(toMonth, 1)}-01T00:00:00.000Z` };
}

function hourMs(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? Math.floor(ms / HOUR_MS) * HOUR_MS : null;
}

function monthOfMs(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

async function excludedCount(db, network, start, end) {
  const { rows } = await db.query(
    `select count(*)::int as n
       from public.reward_events r
      where r.chain_id = $1
        and r.route_kind = 'trade'
        and r.protocol_amount > 0
        and r.occurred_at >= $2 and r.occurred_at < $3
        and not ${notPublicHiddenCampaignSql("r")}`,
    [network.chainId, start, end],
  );
  return Number(rows[0]?.n || 0);
}

function groupByMonth(buckets) {
  const out = new Map();
  for (const b of buckets) {
    if (b.hour == null || !/^\d+$/.test(b.raw)) continue;
    const month = monthOfMs(b.hour);
    const list = out.get(month) || [];
    list.push(b);
    out.set(month, list);
  }
  return out;
}

// The UP vote check of the shared lanes, from the injected `upvotes` reader
// (financeVoteRevenue.readNativeUpvoteRevenue by default). Solana votes always
// count (founder 2026-10-04), as on /revenue.
function upvoteApprovalFrom(upvotes) {
  return async (network) => {
    if (network.chain === "solana") return { approved: true, reason: null };
    const result = await upvotes(network);
    return { approved: Boolean(result?.approved), reason: result?.reason || null, message: result?.message || null };
  };
}

/**
 * Revenue per month for [fromMonth, toMonth], all mainnets. Reads the same
 * lanes as /revenue and /summary (financeRevenueLanes.sharedRevenueLanes) and
 * values each lane-month exactly as /summary does (event-hour price), so the
 * Close, the tax reserve and Summary agree month by month.
 * @returns {Promise<{months: Record<string, {totalUsd:number|null, lanes:object[]}>, notes:string[], excludedTestCoinEvents:number}>}
 */
export async function monthlyRevenue({ fromMonth, toMonth, db = pool, prices, upvotes = readNativeUpvoteRevenue, networks = accountingNetworks(), env = process.env, readLanes = sharedRevenueLanes }) {
  const { start, end } = windowBounds(fromMonth, toMonth);
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const lanesByMonth = new Map();
  const notes = [];
  let excluded = 0;
  const push = (month, lane) => {
    const list = lanesByMonth.get(month) || [];
    list.push(lane);
    lanesByMonth.set(month, list);
  };

  for (const network of networks) {
    if (!solanaRowsAreMainnet(network, env)) {
      notes.push("This API reads the test database, whose chain 101 rows are Solana devnet, so Solana revenue is left out here. Mainnet revenue is on the live API.");
      continue;
    }
    const shared = await readLanes(db, network, { upvoteApproval: upvoteApprovalFrom(upvotes) });
    notes.push(...(shared.notes || []));
    excluded += await excludedCount(db, network, start, end);
    for (const lane of shared.lanes) {
      const decimals = laneDecimals(lane, network);
      const buckets = lane.buckets
        .map((b) => ({ hour: hourMs(b.hour), raw: String(b.raw || "0").split(".")[0], evidenceCount: b.evidenceCount ?? null }))
        .filter((b) => b.hour != null && b.hour >= startMs && b.hour < endMs);
      for (const [month, list] of groupByMonth(buckets)) {
        const total = list.reduce((s, b) => s + BigInt(b.raw), 0n);
        if (total === 0n) continue;
        const usd = await prices.valueEvents(lane.aggregate.assetSymbol, list.map((b) => ({ hour: b.hour, raw: b.raw })), decimals);
        push(month, {
          chainId: network.chainId,
          chain: network.chain,
          lane: lane.aggregate.lane,
          laneId: lane.aggregate.id,
          source: lane.aggregate.source ?? null,
          asset: lane.aggregate.assetSymbol,
          nativeAmount: atomicToDecimal(total.toString(), decimals),
          evidenceCount: list.every((b) => b.evidenceCount != null) ? list.reduce((s, b) => s + b.evidenceCount, 0) : null,
          amountUsd: usd.amountUsd,
          priceBasis: usd.priceBasis,
          priceSource: usd.priceSource,
        });
      }
    }
  }

  const months = {};
  for (let month = fromMonth; month <= toMonth; month = addMonths(month, 1)) {
    const lanes = lanesByMonth.get(month) || [];
    const unpriced = lanes.some((l) => l.amountUsd == null);
    months[month] = { totalUsd: unpriced ? null : roundUsd(lanes.reduce((s, l) => s + l.amountUsd, 0)), lanes };
  }
  return { months, notes: [...new Set(notes)], excludedTestCoinEvents: excluded };
}

/**
 * Per-event rows for the revenue CSV, oldest first: one row per event of every
 * shared revenue lane (same filters, amounts and test-coin rule as /revenue),
 * each at its hour's price. Capped per lane; `truncated` says so.
 */
export async function revenueEventRows({ fromMonth, toMonth, db = pool, prices, fx, upvotes = readNativeUpvoteRevenue, networks = accountingNetworks(), env = process.env, readEvents = revenueLaneEvents }) {
  const { start, end } = windowBounds(fromMonth, toMonth);
  const raw = [];
  const notes = [];
  let truncated = false;
  for (const network of networks) {
    if (!solanaRowsAreMainnet(network, env)) {
      notes.push("Solana rows on this API are devnet and are left out.");
      continue;
    }
    const read = await readEvents(db, network, { start, end, maxRowsPerLane: MAX_EXPORT_ROWS_PER_LANE, upvoteApproval: upvoteApprovalFrom(upvotes) });
    notes.push(...(read.notes || []));
    if (read.truncated) truncated = true;
    for (const e of read.events) raw.push({ network, ...e, priceAsset: priceAssetFor(e.def.assetSymbol) });
  }

  // Hourly closes per price asset, then spot for hours without history. USD lanes are $1.
  const closes = new Map();
  for (const asset of [...new Set(raw.map((r) => r.priceAsset).filter((a) => a && a !== "USD"))]) {
    closes.set(asset, await prices.hourly(asset, raw.filter((r) => r.priceAsset === asset).map((r) => hourMs(r.at)).filter((h) => h != null)));
  }
  const spots = new Map();
  const out = [];
  for (const r of raw) {
    const decimals = Number.isInteger(r.def.decimals) ? r.def.decimals : r.network.decimals;
    const native = atomicToDecimal(r.amountRaw, decimals);
    const hour = hourMs(r.at);
    let price = null;
    let priceSource = null;
    if (r.priceAsset === "USD") {
      price = 1;
      priceSource = "USD amount ($1)";
    } else if (r.priceAsset) {
      price = closes.get(r.priceAsset)?.get(hour) ?? null;
      priceSource = price != null ? `Binance ${r.priceAsset}USDT 1h close` : null;
      if (price == null) {
        if (!spots.has(r.priceAsset)) spots.set(r.priceAsset, await prices.spot(r.priceAsset).catch(() => null));
        const spot = spots.get(r.priceAsset);
        if (spot) {
          price = spot.priceUsd;
          priceSource = `${spot.source} (current price, no history for that hour)`;
        }
      }
    }
    const amountUsd = price != null && native != null ? roundUsd(Number(native) * price) : null;
    const date = new Date(r.at).toISOString();
    const eur = await fx.rate(date.slice(0, 10)).catch(() => null);
    out.push({
      occurredAt: date,
      month: monthOf(date),
      chainId: r.network.chainId,
      chain: r.network.chain,
      lane: r.def.lane,
      laneId: r.def.id,
      source: r.def.source,
      asset: r.def.assetSymbol,
      amountNative: native,
      priceUsd: price,
      amountUsd,
      priceSource,
      usdPerEur: eur?.usdPerEur ?? null,
      amountEur: amountUsd != null && eur?.usdPerEur ? roundUsd(amountUsd / eur.usdPerEur) : null,
      fxSource: eur?.source ?? null,
      txHash: r.txHash,
      logIndex: r.logIndex,
      campaignAddress: r.campaign,
      reference: r.reference,
      eventId: r.eventId,
    });
  }
  out.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
  return { rows: out, notes: [...new Set(notes)], truncated };
}

// Fee-routing destination ids (financeFeeRoutingSolana.js / financeFeeRoutingEvm.js).
const MULTISIG_ID = { solana: "squads_vault", evm: "safe" };
const OPERATOR_ID = { solana: "route_operator", evm: "protocol_operator" };
const PROTOCOL_VAULT_ID = "protocol_vault";

function nativeOf(destination, symbol) {
  const b = (destination?.balances || []).find((x) => x.asset === symbol);
  if (!destination) return { address: null, status: "missing", amount: null, raw: null, amountUsd: null, priceUsd: null };
  if (!b || b.status !== "ok") return { address: destination.address || null, status: b?.status || "unknown", amount: null, raw: null, amountUsd: null, priceUsd: null };
  return { address: destination.address || null, status: "ok", amount: b.amount, raw: String(b.raw), amountUsd: b.amountUsd ?? null, priceUsd: b.priceUsd ?? null };
}

/**
 * Balances now, from the fee-routing read model (all mainnets): per chain the
 * multisig (Squads vault / Safe, the only distributable money), the operator
 * wallet (the buffer, capped at $10k, never distributed) and the protocol
 * vault (not yet forwarded). Plus Ours / held / owed totals for the close.
 * Only the native asset of the multisig counts (a Safe's WBNB / WETH is left out).
 */
export async function currentBalances({ db = pool, build = cachedFeeRouting, networks = feeRoutingAllNetworks(), prices } = {}) {
  const settled = await Promise.allSettled(networks.map((network) => build({ network, days: 30, db, ...(prices ? { prices } : {}) })));
  const datas = [];
  const errors = [];
  const chains = [];
  settled.forEach((result, index) => {
    const network = networks[index];
    const kind = network.chain === "solana" ? "solana" : "evm";
    const base = { chainId: network.chainId, chain: network.chain, asset: network.nativeSymbol, decimals: network.nativeDecimals };
    if (result.status !== "fulfilled") {
      errors.push(`Chain ${network.chainId}: balances could not be read.`);
      chains.push({ ...base, multisigAddress: null, multisigUsd: null, multisigRaw: null, multisigAmount: null, priceUsd: null, operator: null, protocolVault: null, oursUsd: null, heldUsd: null });
      return;
    }
    const data = result.value;
    datas.push(data);
    const byId = new Map((data.destinations || []).map((d) => [d.id, d]));
    const spot = (data.prices || []).find((p) => p.asset === network.nativeSymbol)?.priceUsd ?? null;
    const multisig = nativeOf(byId.get(MULTISIG_ID[kind]), network.nativeSymbol);
    if (multisig.status !== "ok") errors.push(`Chain ${network.chainId}: the multisig balance could not be read.`);
    chains.push({
      ...base,
      multisigAddress: multisig.address,
      multisigUsd: multisig.status === "ok" ? multisig.amountUsd : null,
      multisigRaw: multisig.status === "ok" ? multisig.raw : null,
      multisigAmount: multisig.amount,
      priceUsd: multisig.priceUsd ?? spot,
      operator: nativeOf(byId.get(OPERATOR_ID[kind]), network.nativeSymbol),
      protocolVault: nativeOf(byId.get(PROTOCOL_VAULT_ID), network.nativeSymbol),
      oursUsd: data.totals?.ours?.amountUsd ?? null,
      heldUsd: data.totals?.holdings?.amountUsd ?? null,
    });
  });
  const ours = mergeTotals(datas.map((d) => d.totals?.ours));
  const held = mergeTotals(datas.map((d) => d.totals?.holdings));
  const failed = settled.some((r) => r.status !== "fulfilled");
  const oursUsd = !failed && ours.missingPriceCount === 0 && ours.unknownAmountCount === 0 ? ours.amountUsd ?? 0 : null;
  const heldUsd = !failed && held.missingPriceCount === 0 && held.unknownAmountCount === 0 ? held.amountUsd ?? 0 : null;
  const sumKnown = (pick) => (chains.every((c) => pick(c) != null) ? roundUsd(chains.reduce((s, c) => s + pick(c), 0)) : null);
  return {
    asOf: new Date().toISOString(),
    oursUsd,
    heldUsd,
    owedUsd: oursUsd != null && heldUsd != null ? roundUsd(heldUsd - oursUsd) : null,
    multisigUsd: sumKnown((c) => c.multisigUsd),
    operatorUsd: sumKnown((c) => (c.operator?.status === "ok" ? c.operator.amountUsd : null)),
    chains,
    prices: datas.flatMap((d) => d.prices || []),
    errors,
    note: "Balances at spot, read from the fee-routing map. Ours = protocol-owned balances (operator wallet, protocol vault, multisig, ...); owed = everything else held (creator, league, MWL, recruiter, airdrop pots and mixed balances).",
  };
}
