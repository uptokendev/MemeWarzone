// Treasury-router scan state for the finance read models (Payouts, Fee routing,
// Status). Read-only: one SELECT on indexer_state for the indexer's
// rewards-router:<address> cursors, one on campaigns + curve_trades for coins
// that traded on a router before the indexer started recording it.
//
// Why: a vault can hold money that no recorded reward explains. That is a real
// problem when the router scan is missing or stuck, or when public coins traded
// before recording started. It is expected when only hidden test coins traded
// before the start block that was chosen on purpose so their trades are not
// credited (gen-6 BNB and Robinhood, 2026-10-04).

import { publicHiddenWhere } from "./publicHiddenSql.js";
import { evmGen7RouterScanEntry } from "./evmGen7Fees.js";

/** A cursor that has not moved for this long counts as stuck. */
export const ROUTER_SCAN_STALE_MS = 3 * 60 * 60 * 1000;

// Mirrors configuredTreasuryRouters in realtime-indexer/src/indexer.ts: the
// known routers (TREASURY_ROUTERS_<id> replaces them) plus the launch
// generation's TreasuryRouterV4 from TREASURY_ROUTERS_EXTRA_<id> on the indexer,
// plus generation 7's own TreasuryRouterV4 from EVM_GEN7_ROUTER_<id> (evmGen7Fees.js).
// The gen-6 start blocks are later than the gen-6 deploys (BNB 125085243,
// Robinhood 77307987) on purpose, so the founder's test-coin trades before
// them are not credited.
const KNOWN_ROUTERS = Object.freeze({
  56: [
    { address: "0xe635aa43fe5707561c8c3c655225da5c3e4c2239", startBlock: 123629203 },
    { address: "0xe157a6fdf19cab61f2eca048966f137a3240a921", startBlock: 116800000 },
  ],
  4663: [{ address: "0xda0a9ed9e68d2b468257abd66465fdd94f4338bb", startBlock: 70863388 }],
});
const EXTRA_ROUTERS = Object.freeze({
  56: [{ address: "0x8c8141b84cdb4634829cf1936f1e8cc14c61ceaa", startBlock: 125566831 }],
  4663: [{ address: "0x49ae38b19664d90b410ae860b9604e1bc5f7ab5d", startBlock: 79450621 }],
});

function parseRouterEntries(raw) {
  return String(raw || "").split(",").map((entry) => {
    const [address, block] = entry.trim().split("@");
    return { address: String(address || "").toLowerCase(), startBlock: Number(block || 0) };
  }).filter((r) => /^0x[a-f0-9]{40}$/.test(r.address));
}

/** Routers the indexer scans on this chain, with the block it starts recording each. */
export function routerRecordingStarts(chainId, env = {}) {
  const id = Number(chainId);
  const replace = String(env[`TREASURY_ROUTERS_${id}`] || "").trim();
  const extraEnv = String(env[`TREASURY_ROUTERS_EXTRA_${id}`] || "").trim();
  const base = replace ? parseRouterEntries(replace) : (KNOWN_ROUTERS[id] || []).map((r) => ({ ...r }));
  const extra = extraEnv ? parseRouterEntries(extraEnv) : (EXTRA_ROUTERS[id] || []).map((r) => ({ ...r }));
  for (const router of extra) if (!base.some((r) => r.address === router.address)) base.push(router);
  const gen7 = evmGen7RouterScanEntry(id, env);
  if (gen7 && !base.some((r) => r.address === gen7.address)) base.push(gen7);
  return base;
}

function errorText(error) {
  if (error?.code === "42P01" || error?.code === "42703") return `Table or column missing (${error.code}).`;
  return String(error?.message || "Query failed.").slice(0, 200);
}

/**
 * Reads the scan state. Returns { routers, cursors, used, preStart, error }.
 * `used` are the routers coins point at (campaigns.fee_recipient_address).
 */
export async function readRouterScan(db, chainId, { env = {} } = {}) {
  const routers = routerRecordingStarts(chainId, env);
  try {
    const cursors = await db.query(`
      select lower(substr(cursor, length('rewards-router:') + 1)) as router,
             last_indexed_block::text as block, updated_at
        from public.indexer_state
       where chain_id = $1 and cursor like 'rewards-router:%'`, [chainId]);
    const used = await db.query(`
      select lower(fee_recipient_address) as router, count(*)::int as coins
        from public.campaigns
       where chain_id = $1 and fee_recipient_address is not null
       group by 1`, [chainId]);
    const preStart = routers.length === 0 ? { rows: [] } : await db.query(`
      select s.router, s.start_block::text as start_block, c.symbol, lower(c.campaign_address) as campaign,
             (${publicHiddenWhere("c")}) as hidden,
             count(*)::int as trades, max(t.block_number)::text as last_block
        from unnest($2::text[], $3::bigint[]) as s(router, start_block)
        join public.campaigns c on c.chain_id = $1 and lower(c.fee_recipient_address) = s.router
        join public.curve_trades t on t.chain_id = c.chain_id and lower(t.campaign_address) = lower(c.campaign_address)
       where t.block_number < s.start_block
       group by 1, 2, 3, 4, 5`, [chainId, routers.map((r) => r.address), routers.map((r) => String(r.startBlock))]);
    return {
      routers,
      cursors: cursors.rows.map((r) => ({ router: r.router, block: Number(r.block), updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null })),
      used: used.rows.filter((r) => /^0x[a-f0-9]{40}$/.test(r.router)).map((r) => ({ router: r.router, coins: Number(r.coins) })),
      preStart: preStart.rows.map((r) => ({ router: r.router, startBlock: Number(r.start_block), symbol: r.symbol || null, campaign: r.campaign, hidden: r.hidden === true, trades: Number(r.trades), lastBlock: Number(r.last_block) })),
      error: null,
    };
  } catch (error) {
    return { routers, cursors: [], used: [], preStart: [], error: errorText(error) };
  }
}

export function shortRouter(address) {
  const s = String(address || "");
  return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function hoursText(ms) {
  const h = ms / 3_600_000;
  return h >= 10 ? `${Math.round(h)} hours` : `${Math.round(h * 10) / 10} hours`;
}

/**
 * Pure verdict on a readRouterScan result.
 * status: unknown (not read) | problem (a cursor is missing or stuck) | current.
 * problems: one plain sentence per missing or stuck router.
 * preStartHidden / preStartPublic: coins that traded on a router before its start block.
 */
export function routerScanVerdict(scan, { now, staleMs = ROUTER_SCAN_STALE_MS } = {}) {
  if (!scan || scan.error) return { status: "unknown", error: scan?.error || "Router scan not read.", problems: [], preStartHidden: [], preStartPublic: [], routerCount: 0 };
  const nowMs = Date.parse(now || new Date().toISOString());
  const expected = new Map();
  for (const r of scan.routers || []) expected.set(r.address, r.startBlock);
  for (const u of scan.used || []) if (!expected.has(u.router)) expected.set(u.router, null);
  const byRouter = new Map((scan.cursors || []).map((c) => [c.router, c]));
  const problems = [];
  for (const [router] of expected) {
    const cursor = byRouter.get(router);
    if (!cursor) { problems.push(`The indexer has no scan cursor for router ${shortRouter(router)}, so trades on it are not being recorded.`); continue; }
    const age = cursor.updatedAt ? nowMs - Date.parse(cursor.updatedAt) : Infinity;
    if (!(age <= staleMs)) {
      problems.push(`The indexer's scan of router ${shortRouter(router)} has not moved for ${Number.isFinite(age) ? hoursText(age) : "an unknown time"} (last block ${cursor.block}), so new trades on it are not being recorded.`);
    }
  }
  const pre = scan.preStart || [];
  return {
    status: problems.length ? "problem" : "current",
    error: null,
    problems,
    preStartHidden: pre.filter((p) => p.hidden),
    preStartPublic: pre.filter((p) => !p.hidden),
    routerCount: expected.size,
  };
}

/** "MWZBNB (2 trades, router 0x8c81…ceaa, recording from block 125566831)" per coin. */
export function preStartCoinsText(rows) {
  return rows.map((r) => `${r.symbol || shortRouter(r.campaign)} (${r.trades} trade${r.trades === 1 ? "" : "s"} on router ${shortRouter(r.router)} before block ${r.startBlock})`).join(", ");
}

export function startBlocksText(rows) {
  return [...new Set(rows.map((r) => r.startBlock))].join(", ");
}
