/**
 * Command Center read models for the swap widget (2026-10-23). Read-only.
 *
 *   buildWidgetUsage    GET /api/admin/widget/usage: daily counts per event (widget_usage_daily), the funnel
 *                       load -> quote -> build -> landed, by chain, by partner, top websites.
 *   buildWidgetFinance  GET /api/admin/finance/widget: landed widget swaps and their money per chain, partner and
 *                       website, for imports and for generation 8 coins, plus each partner's earned / paid / sending /
 *                       owed from the existing partner ledger (importFeePartnersAdmin).
 *
 * Landed widget swaps come from ONE query (widgetSwapRows), so usage and finance count the same swaps:
 *   imports  fee rows the fee scanner marked swap_source = 'widget' (landed fingerprint + wallet = a widget build),
 *            not by our own wallets (internal_wallet, as the revenue lanes). Partner = the fee row's partner_id (the
 *            partner that is paid), website = widget_host. Volume = fee_raw x 10000 / the build's fee bps (floor), the
 *            native leg the fee was taken from; the build's quoted native amount when the rate is unknown.
 *   gen-8    trade accruals of the configured hook(s) (as financeGen8.js) whose hookData referrer is
 *            GEN8_REFERRER_WIDGET, test coins (hidden campaigns) left out as in the gen-8 revenue lane. Partner = the
 *            gen8_partner_fees ledger (graduated partner swaps); website = the widget build with that ledger row's
 *            fingerprint and the trader's wallet, so it is known only for those swaps.
 * Money is summed in BigInt from numeric strings; USD comes from the finance price service (financePrices.js,
 * Binance 1h close at each event hour) and is null when no price could be read, never a guess.
 * Usage counts are indicative (any page can send any Origin or partner id); money is only from swaps matched on chain.
 */
import { GEN8_REFERRER_WIDGET } from "../../shared/evmGen8Swap.mjs";
import { gen8ConfigFor } from "./evmGen8Config.js";
import { publicHiddenWhere } from "./publicHiddenSql.js";
import { listPartners as defaultListPartners } from "./importFeePartnersAdmin.js";
import { WIDGET_EVENTS, WIDGET_TRACK_CHAINS, widgetPartnerId } from "./widgetTracking.js";

const DAY_MS = 86_400_000;
const MAX_DAYS = 400;
export const WIDGET_FINANCE_CHAINS = Object.freeze([
  Object.freeze({ chainId: 101, asset: "SOL", decimals: 9 }),
  Object.freeze({ chainId: 56, asset: "BNB", decimals: 18 }),
  Object.freeze({ chainId: 4663, asset: "ETH", decimals: 18 }),
]);
const CHAIN_INFO = new Map(WIDGET_FINANCE_CHAINS.map((c) => [c.chainId, c]));
const FUNNEL_LABELS = { load: "Widget loads", quote: "Quotes", build: "Swaps built", landed: "Swaps landed" };
const TOP_HOSTS = 25;
const GEN8_CHAINS = [56, 97, 4663, 46630];
// The widget tag, inlined as a literal so the partial index evm_gen8_fee_accruals_widget_idx applies. A constant of
// ours (shared/evmGen8Swap.mjs), checked to be a plain address below.
const WIDGET_REFERRER = GEN8_REFERRER_WIDGET.toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(WIDGET_REFERRER)) throw new Error("GEN8_REFERRER_WIDGET is not an address");

export class WidgetQueryError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function dayOf(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? Date.parse(`${raw}T00:00:00Z`) : Date.parse(raw);
  if (!Number.isFinite(ms)) throw new WidgetQueryError(`${label} must be a date (YYYY-MM-DD) or an ISO timestamp.`);
  return new Date(ms).toISOString().slice(0, 10);
}

/** { from, to } as UTC days, both inclusive. Default: the last 30 days up to today. At most 400 days. */
export function widgetWindow(query = {}, now = new Date()) {
  const to = dayOf(query.to, "to") || now.toISOString().slice(0, 10);
  const from = dayOf(query.from, "from") || new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS).toISOString().slice(0, 10);
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
  if (span < 0) throw new WidgetQueryError("from must not be after to.");
  if (span >= MAX_DAYS) throw new WidgetQueryError(`The window is at most ${MAX_DAYS} days.`);
  return { from, to };
}

export function daysBetween(from, to) {
  const out = [];
  for (let ms = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); ms <= end; ms += DAY_MS) out.push(new Date(ms).toISOString().slice(0, 10));
  return out;
}

/** chainId filter of the usage read: null (all) or one of the widget chains. */
export function usageChainFilter(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "all") return null;
  const id = Number(raw);
  if (!WIDGET_TRACK_CHAINS.includes(id)) throw new WidgetQueryError(`chainId must be one of ${WIDGET_TRACK_CHAINS.join(", ")}.`);
  return id;
}

/** partner filter: null (all), '' for "none" (swaps without a partner), or a partner id. */
export function usagePartnerFilter(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw || raw === "all") return null;
  if (raw === "none") return "";
  const id = widgetPartnerId(raw);
  if (!id) throw new WidgetQueryError("partner must be a partner id, none or all.");
  return id;
}

/** The configured gen-8 hooks per chain (gen8ConfigFor, as financeGen8.js): [{ chainId, hook }] lower-cased. */
export function widgetGen8Hooks(env = process.env) {
  const out = [];
  for (const chainId of GEN8_CHAINS) {
    const cfg = gen8ConfigFor(chainId, env);
    if (cfg?.hook) out.push({ chainId, hook: String(cfg.hook).toLowerCase() });
  }
  return out;
}

async function widgetTables(db) {
  const { rows } = await db.query(
    `select to_regclass('public.widget_usage_daily') is not null as usage,
            to_regclass('public.widget_swap_builds') is not null as builds,
            exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'finance_import_swap_fees' and column_name = 'swap_source') as fee_marks,
            to_regclass('public.evm_gen8_fee_accruals') is not null as gen8,
            to_regclass('public.gen8_partner_fees') is not null as gen8_partner,
            to_regclass('public.import_fee_partners') is not null as partners`,
  );
  const r = rows?.[0] || {};
  return { usage: r.usage === true, builds: r.builds === true, feeMarks: r.fee_marks === true, gen8: r.gen8 === true, gen8Partner: r.gen8_partner === true, partners: r.partners === true };
}

const big = (v) => (v == null || v === "" ? 0n : BigInt(String(v).split(".")[0]));

/**
 * The landed widget swaps of the window, grouped per (kind, chain, partner, website, phase, hour), with their money.
 * The single source for usage "landed" and for finance (see the header). chainIds limits the chains; hooks the gen-8
 * hooks ([{ chainId, hook }]).
 */
export async function widgetSwapRows(db, tables, { from, to, chainIds, hooks }) {
  const out = [];
  if (tables.feeMarks && tables.builds) {
    const { rows } = await db.query(
      `select f.chain_id, coalesce(f.partner_id, '') as partner_id, coalesce(f.widget_host, '') as host, date_trunc('hour', f.occurred_at) as hour,
              count(*)::int as swaps, sum(f.fee_raw)::text as fee, sum(f.creator_raw)::text as creator, sum(f.partner_raw)::text as partner,
              sum(case when b.fee_bps > 0 then div(f.fee_raw * 10000, b.fee_bps) else coalesce(b.native_raw, 0) end)::text as volume
         from public.finance_import_swap_fees f
         left join public.widget_swap_builds b on b.id = f.widget_build_id
        where f.swap_source = 'widget' and f.chain_id = any($3::int[]) and not f.internal_wallet
          and f.occurred_at >= $1::date and f.occurred_at < ($2::date + 1)
        group by 1, 2, 3, 4`,
      [from, to, chainIds],
    );
    for (const r of rows) out.push({ kind: "import", phase: null, ...r });
  }
  const gen8Hooks = (hooks || []).filter((h) => chainIds.includes(Number(h.chainId)));
  if (tables.gen8 && gen8Hooks.length) {
    const pJoin = tables.gen8Partner ? "left join public.gen8_partner_fees p on p.chain_id = a.chain_id and p.tx_hash = a.tx_hash and p.log_index = a.log_index" : "";
    const bJoin = tables.gen8Partner && tables.builds ? "left join public.widget_swap_builds b on b.chain_id = a.chain_id and b.fingerprint = p.fingerprint and b.wallet = lower(a.trader)" : "";
    const { rows } = await db.query(
      `select a.chain_id, ${pJoin ? "coalesce(p.partner_id, '')" : "''"} as partner_id, ${bJoin ? "coalesce(b.host, '')" : "''"} as host, a.phase,
              date_trunc('hour', a.block_time) as hour, count(*)::int as swaps,
              sum(a.curve_amount)::text as volume, sum(a.fee)::text as fee, sum(a.creator_share)::text as creator, sum(a.protocol)::text as protocol,
              ${pJoin ? "sum(coalesce(p.partner_raw, 0))::text" : "'0'"} as partner
         from public.evm_gen8_fee_accruals a ${pJoin} ${bJoin}
        where (a.chain_id, a.hook_address) in (select * from unnest($3::int[], $4::text[]))
          and a.kind = 'trade' and lower(coalesce(a.referrer, '')) = '${WIDGET_REFERRER}'
          and a.block_time >= $1::date and a.block_time < ($2::date + 1)
          and not exists (
            select 1 from public.campaigns hc
             where hc.chain_id = a.chain_id and hc.campaign_address is not null
               and lower(hc.campaign_address) = lower(a.token_address) and ${publicHiddenWhere("hc")}
          )
        group by 1, 2, 3, 4, 5`,
      [from, to, gen8Hooks.map((h) => Number(h.chainId)), gen8Hooks.map((h) => String(h.hook).toLowerCase())],
    );
    for (const r of rows) out.push({ kind: "gen8", ...r });
  }
  return out;
}

async function partnerNames(db, tables) {
  if (!tables.partners) return new Map();
  const { rows } = await db.query(`select id, min(name) as name from public.import_fee_partners group by id`);
  return new Map(rows.map((r) => [String(r.id), String(r.name)]));
}

const zeroCounts = () => ({ load: 0, quote: 0, build: 0, approval: 0, bonding_trade: 0, landed: 0 });

function bump(map, key, seed, event, n) {
  if (!map.has(key)) map.set(key, { ...seed, ...zeroCounts() });
  map.get(key)[event] += Number(n || 0);
}

function rankHosts(map) {
  const score = (r) => r.load + r.quote + r.build + r.approval + r.bonding_trade + r.landed;
  return [...map.values()].sort((a, b) => score(b) - score(a) || a.host.localeCompare(b.host)).slice(0, TOP_HOSTS);
}

function hourMsOf(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

const USAGE_NOTES = [
  "Counts are daily per website (the hostname the browser sent as Origin or Referer). No cookies, IP addresses or visitor ids are stored.",
  "Usage counts are indicative: any page can send any Origin or partner id. Money figures come only from swaps matched on chain.",
  "Token lookups are cached by browsers for up to 60 seconds (15 for generation 8 coins), so repeat views within that time are not counted as loads. Counts are written every 15 seconds.",
  "Landed swaps are the ones on the Finance > Widget page: imported and graduated coins once the fee scanner matched the landed fee to the widget build (every 5 minutes, looking back 7 days), partner = the partner paid; generation 8 coins by the widget tag in the hook fee. Our own wallets and test coins are left out. Solana DBC bonding trades do not pass the API and are not counted.",
];

/** The usage read model (see the header). Never reads IPs or wallets: there are none in the usage table. */
export async function buildWidgetUsage({ db, from, to, chainId = null, partner = null, hooks = widgetGen8Hooks() }) {
  const days = daysBetween(from, to);
  const base = { ok: true, from, to, chainId, partner, events: [...WIDGET_EVENTS] };
  const tables = db ? await widgetTables(db) : { usage: false };
  if (!tables.usage) {
    return { ...base, schemaMissing: true, totals: zeroCounts(), series: days.map((day) => ({ day, ...zeroCounts() })), funnel: funnelOf(zeroCounts()), byChain: [], byPartner: [], topHosts: [], notes: USAGE_NOTES };
  }
  const params = [from, to];
  let filter = "";
  if (chainId != null) {
    params.push(chainId);
    filter += ` and chain_id = $${params.length}`;
  }
  if (partner != null) {
    params.push(partner);
    filter += ` and partner_id = $${params.length}`;
  }
  const where = `where day between $1::date and $2::date${filter}`;
  const [series, chains, partners, hosts, landed, names] = await Promise.all([
    db.query(`select day::text as day, event, sum(count)::text as n from public.widget_usage_daily ${where} group by 1, 2`, params),
    db.query(`select chain_id, event, sum(count)::text as n from public.widget_usage_daily ${where} group by 1, 2`, params),
    db.query(`select partner_id, event, sum(count)::text as n from public.widget_usage_daily ${where} group by 1, 2`, params),
    db.query(`select host, event, sum(count)::text as n from public.widget_usage_daily ${where} group by 1, 2`, params),
    widgetSwapRows(db, tables, { from, to, chainIds: [...WIDGET_TRACK_CHAINS], hooks }),
    partnerNames(db, tables),
  ]);
  const byDay = new Map(days.map((day) => [day, { day, ...zeroCounts() }]));
  const byChain = new Map();
  const byPartner = new Map();
  const byHost = new Map();
  const totals = zeroCounts();
  for (const r of series.rows) {
    if (!WIDGET_EVENTS.includes(r.event) || !byDay.has(r.day)) continue;
    byDay.get(r.day)[r.event] += Number(r.n);
    totals[r.event] += Number(r.n);
  }
  for (const r of chains.rows) if (WIDGET_EVENTS.includes(r.event)) bump(byChain, Number(r.chain_id), { chainId: Number(r.chain_id) }, r.event, r.n);
  for (const r of partners.rows) if (WIDGET_EVENTS.includes(r.event)) bump(byPartner, String(r.partner_id), { partnerId: String(r.partner_id) }, r.event, r.n);
  for (const r of hosts.rows) if (WIDGET_EVENTS.includes(r.event)) bump(byHost, String(r.host), { host: String(r.host) }, r.event, r.n);
  for (const r of landed) {
    const rowChain = Number(r.chain_id);
    const rowPartner = String(r.partner_id || "");
    if (chainId != null && rowChain !== chainId) continue;
    if (partner != null && rowPartner !== partner) continue;
    const n = Number(r.swaps || 0);
    const hour = hourMsOf(r.hour);
    const day = hour == null ? null : new Date(hour).toISOString().slice(0, 10);
    totals.landed += n;
    if (day && byDay.has(day)) byDay.get(day).landed += n;
    bump(byChain, rowChain, { chainId: rowChain }, "landed", n);
    bump(byPartner, rowPartner, { partnerId: rowPartner }, "landed", n);
    bump(byHost, String(r.host || ""), { host: String(r.host || "") }, "landed", n);
  }
  return {
    ...base,
    schemaMissing: false,
    totals,
    series: [...byDay.values()],
    funnel: funnelOf(totals),
    byChain: [...byChain.values()].sort((a, b) => a.chainId - b.chainId),
    byPartner: [...byPartner.values()]
      .map((row) => ({ ...row, name: row.partnerId ? names.get(row.partnerId) ?? null : null }))
      .sort((a, b) => (a.partnerId === "" ? 1 : b.partnerId === "" ? -1 : a.partnerId.localeCompare(b.partnerId))),
    topHosts: rankHosts(byHost),
    notes: USAGE_NOTES,
  };
}

/** load -> quote -> build -> landed, each with its share of the step before (null when the step before is 0). */
export function funnelOf(totals) {
  const steps = ["load", "quote", "build", "landed"];
  return steps.map((step, i) => {
    const count = Number(totals[step] || 0);
    const previous = i === 0 ? null : Number(totals[steps[i - 1]] || 0);
    return { step, label: FUNNEL_LABELS[step], count, rateFromPrevious: previous ? count / previous : null };
  });
}

// ------------------------------------------------------------------ finance

const IMPORT_FIGURES = ["volume", "fee", "creator", "partner", "net"];
const GEN8_FIGURES = ["volume", "fee", "creator", "protocol", "partner", "net"];

function newGroup(seed, figures) {
  return { seed, swaps: 0, bondingSwaps: 0, postSwaps: 0, sums: Object.fromEntries(figures.map((f) => [f, 0n])), hours: new Map() };
}

function addTo(group, figures, hourMs, values, swaps, phase = null) {
  group.swaps += swaps;
  if (phase === "bonding") group.bondingSwaps += swaps;
  if (phase === "post") group.postSwaps += swaps;
  const bucket = group.hours.get(hourMs) || Object.fromEntries(figures.map((f) => [f, 0n]));
  for (const f of figures) {
    group.sums[f] += values[f];
    bucket[f] += values[f];
  }
  group.hours.set(hourMs, bucket);
}

async function usdOf(group, figures, asset, decimals, prices) {
  const out = Object.fromEntries(figures.map((f) => [f, null]));
  out.priceBasis = null;
  if (!prices) return out;
  for (const f of figures) {
    const buckets = [...group.hours.entries()].map(([hour, v]) => ({ hour, raw: (v[f] > 0n ? v[f] : 0n).toString() }));
    try {
      const valued = await prices.valueEvents(asset, buckets, decimals);
      out[f] = valued.amountUsd ?? null;
      if (f === "fee") out.priceBasis = valued.priceBasis ?? null;
    } catch {
      out[f] = null;
    }
  }
  return out;
}

async function groupRow(group, figures, prices) {
  const info = CHAIN_INFO.get(group.seed.chainId);
  const raw = Object.fromEntries(figures.map((f) => [`${f}Raw`, group.sums[f].toString()]));
  return { ...group.seed, asset: info.asset, decimals: info.decimals, swaps: group.swaps, ...raw, usd: await usdOf(group, figures, info.asset, info.decimals, prices) };
}

/** Totals of priced rows: a figure is null when any row with a non-zero amount has no USD (no partial sums). */
function usdTotals(rows, figures) {
  const out = {};
  for (const f of figures) {
    let sum = 0;
    let missing = false;
    for (const row of rows) {
      const raw = big(row[`${f}Raw`]);
      if (raw === 0n) continue;
      if (row.usd?.[f] == null) missing = true;
      else sum += row.usd[f];
    }
    out[f] = missing ? null : Math.round(sum * 1e6) / 1e6;
  }
  return out;
}

/** The finance read model (see the header). prices: createPriceService() (financePrices.js) or null for native only. */
export async function buildWidgetFinance({ db, from, to, prices = null, listPartners = defaultListPartners, hooks = widgetGen8Hooks() }) {
  const chainIds = WIDGET_FINANCE_CHAINS.map((c) => c.chainId);
  const notes = [
    "Imports: landed swaps whose fee row matches a widget build by fingerprint and wallet. Volume is the native side the fee was taken from (fee / fee rate). Swaps by our own wallets are left out, as in the revenue lanes.",
    "Partner earned, paid, sending and owed are all-time ledger figures (the same as the Partners page); the swap figures are for the chosen days.",
    "Generation 8: trades of the configured hook with the widget tag in the hook fee. MemeWarzone share is the protocol slice of the hook fee; the partner share (graduated coins only) is paid from MemeWarzone's import share in the ImportFeeVault. Test coins are left out.",
    "USD at the Binance 1h close of each swap's hour; empty when no price could be read.",
  ];
  const empty = { ok: true, from, to, notes, imports: { byChain: [], byPartner: [], byHost: [] }, gen8: { available: false, byChain: [], byPartner: [], byHost: [] }, totals: { swaps: 0, usd: { volume: null, fee: null, creator: null, partner: null, net: null, priceBasis: null } } };
  const tables = db ? await widgetTables(db) : { feeMarks: false, gen8: false };
  if (!tables.feeMarks || !tables.builds) return { ...empty, schemaMissing: true };

  const swapRows = await widgetSwapRows(db, tables, { from, to, chainIds, hooks });
  const iChain = new Map();
  const iPartner = new Map();
  const iHost = new Map();
  const gChain = new Map();
  const gPartner = new Map();
  const gHost = new Map();
  for (const r of swapRows) {
    const chainId = Number(r.chain_id);
    const hour = hourMsOf(r.hour);
    const pid = String(r.partner_id || "");
    const host = String(r.host || "");
    const gen8 = r.kind === "gen8";
    const figures = gen8 ? GEN8_FIGURES : IMPORT_FIGURES;
    const fee = big(r.fee);
    const creator = big(r.creator);
    const partner = big(r.partner);
    const values = gen8
      ? { volume: big(r.volume), fee, creator, protocol: big(r.protocol), partner, net: big(r.protocol) - partner }
      : { volume: big(r.volume), fee, creator, partner, net: fee - creator - partner };
    const maps = gen8 ? [gChain, gPartner, gHost] : [iChain, iPartner, iHost];
    for (const [map, key, seed] of [
      [maps[0], `${chainId}`, { chainId }],
      [maps[1], `${chainId}:${pid}`, { chainId, partnerId: pid }],
      [maps[2], `${chainId}:${host}`, { chainId, host }],
    ]) {
      if (!map.has(key)) map.set(key, newGroup(seed, figures));
      addTo(map.get(key), figures, hour, values, Number(r.swaps || 0), gen8 ? r.phase : null);
    }
  }

  // ---- partner ledger (all-time), the Partners page's figures
  let ledger = [];
  try {
    ledger = tables.partners ? await listPartners(db) : [];
  } catch (error) {
    if (error?.code !== "42P01" && error?.code !== "42703") throw error;
  }
  const ledgerByKey = new Map(ledger.filter((p) => chainIds.includes(Number(p.chainId))).map((p) => [`${p.chainId}:${p.id}`, p]));
  for (const p of ledgerByKey.values()) {
    const key = `${p.chainId}:${p.id}`;
    if (!iPartner.has(key)) iPartner.set(key, newGroup({ chainId: Number(p.chainId), partnerId: p.id }, IMPORT_FIGURES));
    if (tables.gen8 && p.gen8EarnedRaw !== undefined && Number(p.chainId) !== 101 && !gPartner.has(key)) {
      gPartner.set(key, newGroup({ chainId: Number(p.chainId), partnerId: p.id }, GEN8_FIGURES));
    }
  }

  const sortRows = (rows, by) => rows.sort((a, b) => a.chainId - b.chainId || String(a[by] ?? "").localeCompare(String(b[by] ?? "")));
  const rowsOf = async (map, figures) => Promise.all([...map.values()].map((g) => groupRow(g, figures, prices)));
  const gen8Rows = async (map) => Promise.all([...map.values()].map(async (g) => ({ ...(await groupRow(g, GEN8_FIGURES, prices)), bondingSwaps: g.bondingSwaps, postSwaps: g.postSwaps })));

  const importsByChain = sortRows(await rowsOf(iChain, IMPORT_FIGURES), "chainId");
  const importsByPartner = sortRows(
    (await rowsOf(iPartner, IMPORT_FIGURES)).map((row) => {
      const p = row.partnerId ? ledgerByKey.get(`${row.chainId}:${row.partnerId}`) : null;
      return { ...row, name: p?.name ?? null, active: p ? Boolean(p.active) : null, earnedRaw: p?.earnedRaw ?? "0", paidRaw: p?.paidRaw ?? "0", sendingRaw: p?.sendingRaw ?? "0", owedRaw: p?.owedRaw ?? "0" };
    }),
    "partnerId",
  );
  const importsByHost = sortRows(await rowsOf(iHost, IMPORT_FIGURES), "host");
  const gen8ByChain = sortRows(await gen8Rows(gChain), "chainId");
  const gen8ByHost = sortRows(await gen8Rows(gHost), "host");
  const gen8ByPartner = sortRows(
    (await rowsOf(gPartner, GEN8_FIGURES)).map((row) => {
      const p = row.partnerId ? ledgerByKey.get(`${row.chainId}:${row.partnerId}`) : null;
      return {
        chainId: row.chainId, partnerId: row.partnerId, name: p?.name ?? null, swaps: row.swaps, volumeRaw: row.volumeRaw, partnerRaw: row.partnerRaw,
        earnedRaw: p?.gen8EarnedRaw ?? "0", paidRaw: p?.gen8PaidRaw ?? "0", sendingRaw: p?.gen8SendingRaw ?? "0", owedRaw: p?.gen8OwedRaw ?? "0",
        asset: row.asset, decimals: row.decimals, usd: row.usd,
      };
    }),
    "partnerId",
  );

  const importTotals = usdTotals(importsByChain, IMPORT_FIGURES);
  const gen8Totals = usdTotals(gen8ByChain, ["volume", "fee", "creator", "partner", "net"]);
  const add = (a, b) => (a == null || b == null ? null : Math.round((a + b) * 1e6) / 1e6);
  return {
    ok: true,
    from,
    to,
    schemaMissing: false,
    notes,
    imports: { byChain: importsByChain, byPartner: importsByPartner, byHost: importsByHost },
    gen8: { available: tables.gen8 && hooks.length > 0, byChain: gen8ByChain, byPartner: gen8ByPartner, byHost: gen8ByHost },
    totals: {
      swaps: importsByChain.reduce((s, r) => s + r.swaps, 0) + gen8ByChain.reduce((s, r) => s + r.swaps, 0),
      usd: {
        volume: add(importTotals.volume, gen8Totals.volume),
        fee: add(importTotals.fee, gen8Totals.fee),
        creator: add(importTotals.creator, gen8Totals.creator),
        partner: add(importTotals.partner, gen8Totals.partner),
        net: add(importTotals.net, gen8Totals.net),
        priceBasis: importsByChain[0]?.usd?.priceBasis ?? gen8ByChain[0]?.usd?.priceBasis ?? null,
      },
    },
  };
}
