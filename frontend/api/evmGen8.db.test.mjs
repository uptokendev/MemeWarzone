// EVM generation 8 readers of the API against a throwaway Postgres (step 4, 2026-10-11): the campaign list (raise,
// holders, progress, gen-8 fields), the league pot and the trader boards, market_trades_v, the finance lane and
// /api/admin/finance/gen8, the gen-8 coin lookup used by trade authorization and import swaps. Each check also proves
// that a gen-6/7 coin reads exactly as before, with gen-8 configured or not, and that nothing breaks before the gen-8
// migration is applied.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.env.DBC_THROWAY_PG_PORT ||= "55443";
// market_trades_v carries security_invoker (Postgres 15+), as on Supabase.
if (!process.env.DBC_PG_BIN && fs.existsSync("/usr/lib/postgresql/16/bin/initdb")) process.env.DBC_PG_BIN = "/usr/lib/postgresql/16/bin";
const { startThrowawayPostgres } = await import("../../scripts/dbc/throwaway-postgres.mjs");

// The market tables of the gen-8 indexer test (realtime-indexer/src/tests/gen8/gen8TestDb.ts), WITHOUT the gen-8
// migration: it is applied in the middle of this file, after the "migration missing" checks.
const foundation = fs.readFileSync(path.join(ROOT, "db/migrations/202607290001_war_trade_room_market_continuity_foundation.sql"), "utf8");
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mwz-gen8-api-schema-")), "foundation-without-view.sql");
fs.writeFileSync(tmp, foundation.slice(0, foundation.indexOf("create or replace view public.market_trades_v")));
const pg = await startThrowawayPostgres({
  extraFiles: [
    tmp,
    "db/migrations/20260930_000001_evm_gen5_indexing.sql",
    "realtime-indexer/src/tests/gen8/gen8-test-schema.sql",
    "db/migrations/20260921_000002_market_trades_v_arena_valuation_columns.sql",
  ],
});
process.env.DATABASE_URL = pg.url;
process.env.PG_DISABLE_SSL = "1";
process.env.SOL_USD_PRICE = "150";
process.env.STAGING_LEAGUE_ALLTIME_FALLBACK = "1";
// EVM progress reads go nowhere (connection refused at once): the rows keep their SQL values.
for (const id of [56, 97, 4663, 46630]) process.env[`BSC_RPC_HTTP_${id}`] = "http://127.0.0.1:9";
const db = pg.pool;

test.after(async () => {
  const { pool } = await import("../server/db.js");
  await pool?.end?.().catch(() => {});
  await pg.stop();
});

await db.query(`
  create table if not exists public.votes (
    chain_id integer not null, campaign_address text not null, voter_address text not null,
    amount_raw numeric not null default 0, block_number bigint not null default 0,
    block_timestamp timestamptz not null, status text not null default 'confirmed', asset_address text
  );
  create table if not exists public.vote_aggregates (chain_id integer not null, campaign_address text not null, votes_all_time numeric default 0);
  alter table public.campaigns add column if not exists fee_recipient_address text;
  alter table public.campaign_drafts add column if not exists logo_url text, add column if not exists campaign_address text,
    add column if not exists token_address text, add column if not exists updated_at timestamptz not null default now();
`);

const CHAIN = 97;
const E18 = 10n ** 18n;
const milli = (n) => (BigInt(n) * E18) / 1000n;
const G7 = "0x00000000000000000000000000000000000000a7";
const G8 = "0x00000000000000000000000000000000000000a8";
const HOOK = "0x0000000000000000000000000000000000002aec";
const LAUNCHER = "0x00000000000000000000000000000000000000c8";
const CREATOR7 = "0x00000000000000000000000000000000000000d7";
const CREATOR8 = "0x00000000000000000000000000000000000000d8";
const W1 = "0x0000000000000000000000000000000000000001";
const W2 = "0x0000000000000000000000000000000000000002";
const W3 = "0x0000000000000000000000000000000000000003";
const OPERATOR = "0x00000000000000000000000000000000000000f0";
const GEN8_ENV = { [`EVM_GEN8_LAUNCHER_${CHAIN}`]: LAUNCHER, [`EVM_GEN8_HOOK_${CHAIN}`]: HOOK, [`EVM_GEN8_POOL_MANAGER_${CHAIN}`]: "0x00000000000000000000000000000000000000e8" };
const setGen8 = (on) => { for (const [k, v] of Object.entries(GEN8_ENV)) { if (on) process.env[k] = v; else delete process.env[k]; } };

const { gen8PoolId } = await import("../shared/evmGen8.mjs");
const POOL_ID = gen8PoolId(G8, HOOK);
// A real launch's pool ($150 target, $600 native; the anvil test's numbers) a little into A.
const TICK_START = 258260;
const TICK_GRAD = 221110;
const LIQ_A = 2485145006854016906826n;
const SQRT_NOW = 22110261694031876154866552165313459n;

const at = (h) => new Date(Date.now() - 3 * 86_400_000 + h * 3_600_000).toISOString();
await db.query(
  `insert into public.campaigns (chain_id, campaign_address, token_address, creator_address, name, symbol, meta, created_block, created_at_chain, factory_generation, campaign_generation, is_active)
   values ($1, $2, $2, $3, 'Seven', 'SVN', '{}'::jsonb, 1, $5, 7, 6, true),
          ($1, $4, $4, $6, 'Eight', 'EGT', $7::jsonb, 2, $5, 8, 8, true)`,
  [CHAIN, G7, CREATOR7, G8, at(0), CREATOR8, JSON.stringify({ gen8: { poolId: POOL_ID, hook: HOOK, poolManager: GEN8_ENV[`EVM_GEN8_POOL_MANAGER_${CHAIN}`] } })],
);
let n = 0;
async function trade(campaign, wallet, side, amountRaw, feeRaw, hour, { venue = null, excluded = false } = {}) {
  n += 1;
  await db.query(
    `insert into public.curve_trades (chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet,
       token_amount_raw, bnb_amount_raw, token_amount, bnb_amount, venue, fee_raw, league_excluded)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, 1, $9::numeric / 1e18, $10, $11, $12)`,
    [CHAIN, campaign, `0x${n.toString(16).padStart(64, "0")}`, n, 100 + n, at(hour), side, wallet, amountRaw.toString(), venue, feeRaw.toString(), excluded],
  );
}
// Gen-7 rows carry the trader-side amount (buy cost + fee, sell payout - fee).
await trade(G7, W1, "buy", milli(1020), milli(20), 1);
await trade(G7, W1, "sell", milli(490), milli(10), 2);
// Gen-8 rows carry the curve amount; the fee is on top (buy) or out (sell).
const g8 = { venue: "gen8" };
await trade(G8, CREATOR8, "buy", milli(100), milli(2), 10, { ...g8, excluded: true }); // first buy through the launcher
await trade(G8, W1, "buy", milli(1200), milli(24), 11, g8);
await trade(G8, W2, "buy", milli(500), milli(450), 12, g8); // launch window, 90%
await trade(G8, W1, "sell", milli(300), milli(6), 13, g8);
await trade(G8, OPERATOR, "buy", milli(200), milli(4), 14, { ...g8, excluded: true }); // creator-choice vault buyback
await trade(G8, W3, "buy", milli(100), milli(2), 15, g8);
await trade(G8, W3, "sell", milli(200), milli(4), 16, g8);

const { default: campaigns } = await import("./campaigns-base.js");
const { computeTotalLeagueFeeRawInRange, default: league } = await import("./league.js");
const { clearGen8SchemaCache } = await import("./lib/evmGen8Schema.js");
const { pool: apiPool } = await import("../server/db.js");

async function call(handler, url, extra = {}) {
  const res = {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end(text) { if (text != null) { try { this.body = JSON.parse(String(text)); } catch { this.body = text; } } },
  };
  const u = new URL(url, "http://localhost");
  await handler({ method: "GET", url, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: {}, ...extra }, res);
  return res;
}
const list = async () => {
  const res = await call(campaigns, `/api/campaigns?chainId=${CHAIN}&limit=50`);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.warning, undefined, "rich query, not the basic fallback");
  return Object.fromEntries(res.body.items.map((i) => [i.campaignAddress, i]));
};

test("campaign list before the gen-8 migration: gen-8 configured, nothing breaks, gen-7 unchanged", async () => {
  setGen8(false);
  const off = await list();
  setGen8(true);
  clearGen8SchemaCache(apiPool);
  const on = await list();
  assert.deepEqual(on[G7], off[G7], "gen-7 coin identical");
  assert.equal(Number(on[G7].raisedTotalBnb), 0.5, "gen-7 raise: buys net of fee, sells plus fee");
  // Gen-8 coin: raise without the fee correction already; holders from buyers (no pools table yet).
  assert.equal(Number(on[G8].raisedTotalBnb), 1.6);
  assert.equal(on[G8].holderCount, 5, "distinct buyers until evm_gen8_pools exists");
  assert.equal(on[G8].generation, 8);
  assert.equal(on[G8].gen8.poolId, POOL_ID);
  assert.equal(on[G8].gen8.tradePath, "gen8_pool");
  assert.equal(on[G8].gen8.pool, null);
  assert.equal(on[G8].progressPct, null, "no pool row and no lens: no figure, never the 50 BNB fallback");
  assert.equal(off[G8].generation, undefined, "inert without gen-8 env");
  setGen8(false);
});

test("market_trades_v gen-8 label: patched in place, idempotent, other rows and column types unchanged", async () => {
  await db.query(
    `insert into public.dex_trades (chain_id, campaign_address, token_address, pair_address, tx_hash, log_index, block_number, block_hash, block_time, status, side,
       sender_address, recipient_address, transaction_from, token_amount_raw, native_amount_raw, token_amount, native_amount, price_bnb, execution_source, origin)
     values ($1, $2, $2, $3, '0xd1', 1, 500, '0x', now(), 'confirmed', 'buy', $4, $4, $4, 1, 1000, 1, 1, 1, 'gen8_v4', 'unknown'),
            ($1, $5, $5, $5, '0xd2', 1, 501, '0x', now(), 'confirmed', 'buy', $4, $4, $4, 1, 1000, 1, 1, 1, 'robinhood_v3', 'unknown'),
            ($1, $5, $5, $5, '0xd3', 1, 502, '0x', now(), 'confirmed', 'sell', $4, $4, $4, 1, 1000, 1, 1, 1, 'topaz', 'unknown')`,
    [CHAIN, G8, HOOK, W1, G7],
  );
  const labels = async () => (await db.query(`select "txHash", "marketStage", source from public.market_trades_v where "txHash" like '0xd%' order by 1`)).rows;
  const cols = async () => (await db.query(`select column_name, data_type, ordinal_position from information_schema.columns where table_name = 'market_trades_v' order by ordinal_position`)).rows;
  const before = await labels();
  const colsBefore = await cols();
  assert.deepEqual(before.map((r) => r.marketStage), ["TOPAZ", "ROBINHOOD_V3", "TOPAZ"], "gen-8 rows read as Topaz before");
  const sql = fs.readFileSync(path.join(ROOT, "db/migrations/20261011_000020_market_trades_v_gen8.sql"), "utf8");
  await db.query(sql);
  const after = await labels();
  assert.deepEqual(after.map((r) => [r.marketStage, r.source]), [["GEN8_V4", "gen8_v4"], ["ROBINHOOD_V3", "robinhood_v3"], ["TOPAZ", "topaz"]]);
  assert.deepEqual(await cols(), colsBefore, "same columns and types");
  const opts = (await db.query(`select reloptions from pg_class where oid = 'public.market_trades_v'::regclass`)).rows[0].reloptions;
  assert.deepEqual(opts, ["security_invoker=true"], "options carried over");
  const def1 = (await db.query(`select pg_get_viewdef('public.market_trades_v'::regclass, true) d`)).rows[0].d;
  await db.query(sql); // second run: no change
  const def2 = (await db.query(`select pg_get_viewdef('public.market_trades_v'::regclass, true) d`)).rows[0].d;
  assert.equal(def2, def1);
  assert.equal((def2.match(/gen8_v4/g) || []).length, 3, "one branch per CASE, once");
  const bonding = (await db.query(`select count(*)::int n from public.market_trades_v where source = 'bonding'`)).rows[0].n;
  assert.equal(bonding, 9, "curve rows unchanged");
});

test("gen-8 migration applied: holders and exact progress from evm_gen8_pools; gen-7 still identical", async () => {
  await db.query(fs.readFileSync(path.join(ROOT, "db/migrations/20261011_000010_evm_gen8_indexer.sql"), "utf8"));
  await db.query(
    `insert into public.evm_gen8_pools (chain_id, pool_id, token_address, hook_address, launcher_address, pool_manager_address, creator_address,
       tick_start, tick_grad, liq_a, liq_b, launch_tx, launch_block, last_sqrt_price_x96, holder_count)
     values ($1, $2, $3, $4, $5, '0xe8', $6, $7, $8, $9, 1, '0xaa', 2, $10, 7)`,
    [CHAIN, POOL_ID, G8, HOOK, LAUNCHER, CREATOR8, TICK_START, TICK_GRAD, LIQ_A.toString(), SQRT_NOW.toString()],
  );
  setGen8(false);
  const off = await list();
  setGen8(true);
  clearGen8SchemaCache(apiPool);
  const on = await list();
  assert.deepEqual(on[G7], off[G7], "gen-7 coin identical with the gen-8 join");
  assert.equal(on[G8].holderCount, 7, "holders from evm_gen8_pools");
  const { gen8Progress } = await import("../shared/evmGen8.mjs");
  const expected = gen8Progress({ liqA: LIQ_A, tickStart: TICK_START, tickGrad: TICK_GRAD, sqrtPriceX96: SQRT_NOW }).pct;
  assert.ok(expected > 0 && expected < 100);
  assert.equal(on[G8].progressPct, expected, "progress from the pool row, exact");
  assert.equal(on[G8].gen8.pool.holderCount, 7);
  assert.equal(on[G8].status, "live");
  // Graduated: graduated_at_chain + market stage (dex_pair_address stays empty for gen-8).
  await db.query(`update public.campaigns set graduated_at_chain = now(), graduated_block = 900 where chain_id = $1 and campaign_address = $2`, [CHAIN, G8]);
  await db.query(`update public.evm_gen8_pools set graduated_block = 900 where pool_id = $1`, [POOL_ID]);
  const grad = await list();
  assert.equal(grad[G8].status, "graduated");
  assert.equal(grad[G8].isDexTrading, true);
  assert.equal(grad[G8].dexPool, null);
  assert.equal(grad[G8].gen8.phase, "graduated");
  assert.equal(grad[G8].progressPct, 100);
  await db.query(`update public.campaigns set graduated_at_chain = null, graduated_block = null where chain_id = $1 and campaign_address = $2`, [CHAIN, G8]);
  await db.query(`update public.evm_gen8_pools set graduated_block = null where pool_id = $1`, [POOL_ID]);
  setGen8(false);
});

test("league pot: gen-8 rows pay 37.5% of the recorded fee; gen-7 rows unchanged", async () => {
  const p = (start, end) => computeTotalLeagueFeeRawInRange(CHAIN, start, end, 200, 75);
  const g7Window = [at(0), at(5)];
  setGen8(false);
  const g7Off = await p(...g7Window);
  setGen8(true);
  const g7On = await p(...g7Window);
  assert.equal(g7On, g7Off);
  assert.equal(g7On, (milli(10) * 75n / 100n + milli(5) * 75n / 100n).toString().replace(/^/, ""), "0.75% of 1.0 + 0.5 BNB gross");
  const all = BigInt(await p(null, null));
  const g8Fees = [2, 24, 450, 6, 4, 2, 4].map((f) => (milli(f) * 75n) / 200n).reduce((a, b) => a + b, 0n);
  assert.equal(all, BigInt(g7On) + g8Fees, "gen-8: floor(fee x 75 / 200) per row, launch-window fee included");
  setGen8(false);
});

const board = async (category) => {
  const res = await call(league, `/api/league?${new URLSearchParams({ chainId: String(CHAIN), category, period: "weekly" })}`);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  return res.body.items;
};

test("trader boards: gen-8 amounts trader-side, creator / buyback rows left out; settlement uses the same SQL", async () => {
  setGen8(true);
  const top = await board("top_earner");
  const byWallet = Object.fromEntries(top.map((r) => [r.wallet, r]));
  // W3: sold 0.2 curve (receives 0.196) after buying 0.1 curve (paid 0.102) = +0.094
  assert.equal(String(byWallet[W3].profit_raw), (milli(196) - milli(102)).toString());
  // W1: gen-7 0.49 - 1.02, gen-8 0.294 - 1.224
  assert.equal(String(byWallet[W1].profit_raw), (milli(490) - milli(1020) + milli(294) - milli(1224)).toString());
  assert.equal(byWallet[OPERATOR], undefined, "buyback wallet not in the field");
  assert.equal(top[0].wallet, W3);

  const hits = await board("biggest_hit");
  const byCoin = Object.fromEntries(hits.map((r) => [r.campaign_address, r]));
  assert.equal(byCoin[G8].buyer_address, W1);
  assert.equal(String(byCoin[G8].bnb_amount_raw), milli(1224).toString(), "curve 1.2 + fee 0.024");
  assert.equal(String(byCoin[G7].bnb_amount_raw), milli(1020).toString(), "gen-7 unchanged");

  // The settlement SQL (realtime-indexer/src/rewards/leagueLeaderboard.ts) builds the same expressions.
  const ts = fs.readFileSync(path.join(ROOT, "realtime-indexer/src/rewards/leagueLeaderboard.ts"), "utf8");
  const { gen8TraderNativeRawSql, gen8LeagueRowKeepSql } = await import("./lib/evmGen8LeagueSql.js");
  const body = (src, name) => src.slice(src.indexOf(`function ${name}`), src.indexOf("}\n", src.indexOf(`function ${name}`)));
  const norm = (s) => s.replace(/\s+/g, " ").replace(/\$\{GEN8_ROW\(a\)\}/g, "coalesce(${a}.venue, '') = 'gen8'");
  assert.match(norm(body(ts, "gen8TraderNativeRawSql")), /then \$\{a\}\.bnb_amount_raw::numeric \+ \(case when \$\{a\}\.side = 'buy' then \$\{a\}\.fee_raw::numeric else -\$\{a\}\.fee_raw::numeric end\)/);
  assert.match(gen8TraderNativeRawSql("t").replace(/\s+/g, " "), /then t\.bnb_amount_raw::numeric \+ \(case when t\.side = 'buy' then t\.fee_raw::numeric else -t\.fee_raw::numeric end\)/);
  assert.match(norm(body(ts, "gen8LeagueRowKeepSql")), /NOT \(coalesce\(\$\{a\}\.venue, ''\) = 'gen8' AND coalesce\(\$\{a\}\.league_excluded, false\)\)/);
  assert.equal(gen8LeagueRowKeepSql("t"), "NOT (coalesce(t.venue, '') = 'gen8' AND coalesce(t.league_excluded, false))");
  setGen8(false);
});

test("gen-8 coin lookup: campaigns row first, no chain read for a gen-7 coin; import route and trade authorization refusals", async () => {
  setGen8(true);
  const { findGen8Coin, gen8TradeAuthorizationRefusal } = await import("./lib/evmGen8Coins.js");
  const never = async () => { throw new Error("no RPC for a coin the database knows"); };
  const coin = await findGen8Coin({ chainId: CHAIN, address: G8, db, getProvider: never });
  assert.equal(coin.source, "campaigns");
  assert.equal(coin.poolId, POOL_ID);
  assert.equal(await findGen8Coin({ chainId: CHAIN, address: G7, db, getProvider: never }), null);
  assert.equal(await findGen8Coin({ chainId: 56, address: G8, db, getProvider: never }), null, "chain without gen-8 config");
  const refusal = gen8TradeAuthorizationRefusal(coin, CHAIN);
  assert.equal(refusal.code, "GEN8_TRADES_NOT_SIGNED");
  const { gen8ImportRouteRefusal } = await import("./importSwap.js");
  const imp = await gen8ImportRouteRefusal({ chainId: CHAIN, token: G8 }, { db });
  assert.equal(imp.code, "GEN8_POOL_ROUTE");
  assert.equal(imp.tradePath, "gen8_pool");
  assert.equal(await gen8ImportRouteRefusal({ chainId: CHAIN, token: G7 }, { db }), null);
  assert.equal(await gen8ImportRouteRefusal({ chainId: 101, token: "So11111111111111111111111111111111111111112" }, { db }), null);
  setGen8(false);
  assert.equal(await gen8ImportRouteRefusal({ chainId: CHAIN, token: G8 }, { db }), null, "inert without gen-8 env");
});

test("finance: post-graduation lane and the gen-8 block; no lane and no query without gen-8 config", async () => {
  const at2 = new Date().toISOString();
  const acc = async (log, kind, phase, fee, creator, protocol, curve) => db.query(
    `insert into public.evm_gen8_fee_accruals (chain_id, hook_address, pool_id, token_address, tx_hash, log_index, block_number, block_time, kind, phase,
       curve_amount, fee, creator_share, router_amount, league_weekly, league_monthly, recruiter, squad, airdrop, protocol)
     values ($1, $2, $3, $4, '0xacc', $5, 700, $6, $7, $8, $9, $10, $11, $12, 0, 0, 0, 0, 0, $13)`,
    [CHAIN, HOOK, POOL_ID, G8, log, at2, kind, phase, curve.toString(), fee.toString(), creator.toString(), (fee - creator).toString(), protocol.toString()],
  );
  await acc(1, "trade", "bonding", milli(20), milli(20) * 560n / 10000n, milli(5), milli(1000));
  await acc(2, "graduation", "bonding", milli(40), 0n, milli(33), 0n);
  await acc(3, "trade", "post", milli(10), milli(5), milli(5), milli(1000));
  await acc(4, "trade", "post", milli(4), milli(2), milli(2), milli(400));
  await db.query(
    `insert into public.evm_campaign_events (chain_id, contract_address, contract_kind, campaign_address, event_name, tx_hash, log_index, block_number, block_time, args)
     values ($1, $2, 'gen8_hook', $3, 'CreatorClaimed', '0xcc', 1, 800, now(), $4::jsonb)`,
    [CHAIN, HOOK, G8, JSON.stringify({ amount: milli(3).toString() })],
  );
  const { laneDefinitions, LANE_QUERIES } = await import("./lib/financeRevenueLanes.js");
  const network = { chainId: CHAIN, chain: "bnb", decimals: 18, asset: "BNB" };
  setGen8(false);
  assert.equal(laneDefinitions(network).some((d) => d.key === "gen8_postgrad"), false);
  setGen8(true);
  assert.equal(laneDefinitions(network).find((d) => d.key === "gen8_postgrad").lane, "lp_protocol_share");
  const { rows } = await db.query(LANE_QUERIES.gen8_postgrad, [CHAIN]);
  assert.equal(rows.reduce((s, r) => s + BigInt(r.amount_raw), 0n), milli(7), "post-phase protocol only");

  const { buildGen8Finance, gen8PartnerShareRaw } = await import("./lib/financeGen8.js");
  const f = await buildGen8Finance({ db, chainId: CHAIN });
  assert.equal(f.configured, true);
  assert.equal(f.lanes.trade_post.protocolWei, milli(7).toString());
  assert.equal(f.lanes.graduation.routerWei, milli(40).toString());
  assert.equal(f.lanes.trade_post.creatorWei, milli(7).toString());
  assert.equal(f.claims.CreatorClaimed.amountWei, milli(3).toString());
  assert.equal(f.unclaimedIndexed.creatorWei, (milli(20) * 560n / 10000n + milli(7) - milli(3)).toString());
  assert.equal(f.partner.attributable, false);
  assert.equal(f.live.available, false);
  assert.equal(gen8PartnerShareRaw({ curveAmount: milli(1000), protocol: milli(5) }), milli(1000) * 25n / 10000n);
  assert.equal(gen8PartnerShareRaw({ curveAmount: milli(1000), protocol: 1n }), 1n, "never above the protocol share");
  setGen8(false);
  assert.deepEqual(await buildGen8Finance({ db, chainId: CHAIN }), { chainId: CHAIN, configured: false });
});

// Audit D-L2 (wash netting). Same fixtures and figures as realtime-indexer/src/tests/evmGen8LeagueSettlement
// .integration.test.ts. GW: a graduated gen-8 coin. W4 buys (trader-side 1.000) and sells (trader-side 0.980) in ONE
// transaction: one net buy of 0.020. W5 buys 0.050 in its own transaction. On G8, W6 buys 0.040 and, in the same
// transaction, a row the indexer marked league_excluded sells 0.029: the excluded row is never netted in.
test("wash netting: one transaction's gen-8 legs by one wallet count as one net row; board SQL == settlement SQL", async () => {
  const GW = "0x00000000000000000000000000000000000000a9";
  const CREATORW = "0x00000000000000000000000000000000000000d9";
  const W4 = "0x0000000000000000000000000000000000000004";
  const W5 = "0x0000000000000000000000000000000000000005";
  const W6 = "0x0000000000000000000000000000000000000006";
  await db.query(
    `insert into public.campaigns (chain_id, campaign_address, token_address, creator_address, name, symbol, meta, created_block, created_at_chain,
       graduated_block, graduated_at_chain, factory_generation, campaign_generation, is_active)
     values ($1, $2, $2, $3, 'Wash', 'WSH', '{}'::jsonb, 2, $4, 10000, $5, 8, 8, true)`,
    [CHAIN, GW, CREATORW, at(0), at(18)],
  );
  const t17 = at(17); // one block time for every leg (legs of one transaction share their block)
  const leg = (campaign, tx, logIndex, block, hour, side, wallet, curve, fee, excluded = false) => db.query(
    `insert into public.curve_trades (chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet,
       token_amount_raw, bnb_amount_raw, token_amount, bnb_amount, venue, fee_raw, league_excluded)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, 1, $9::numeric / 1e18, 'gen8', $10, $11)`,
    [CHAIN, campaign, tx, logIndex, block, hour === 17 ? t17 : at(hour), side, wallet, curve.toString(), fee.toString(), excluded],
  );
  const WASH_TX = `0x${"ab".repeat(32)}`;
  await leg(GW, WASH_TX, 7, 5000, 17, "buy", W4, milli(980), milli(20)); // pays 1.000
  await leg(GW, WASH_TX, 9, 5000, 17, "sell", W4, milli(1000), milli(20)); // receives 0.980
  await leg(GW, `0x${"cd".repeat(32)}`, 1, 5001, 17, "buy", W5, milli(49), milli(1)); // pays 0.050
  const MIXED_TX = `0x${"ef".repeat(32)}`;
  await leg(G8, MIXED_TX, 1, 5002, 17, "buy", W6, milli(39), milli(1)); // pays 0.040
  await leg(G8, MIXED_TX, 2, 5002, 17, "sell", W6, milli(30), milli(1), true); // excluded, receives 0.029

  setGen8(true);
  try {
    // biggest_hit: the net buy (0.020), not the 1.000 leg; W5's 0.050 is the coin's biggest hit.
    const hits = await board("biggest_hit");
    const byCoin = Object.fromEntries(hits.map((r) => [r.campaign_address, r]));
    assert.equal(byCoin[GW].buyer_address, W5);
    assert.equal(String(byCoin[GW].bnb_amount_raw), milli(50).toString());
    assert.equal(byCoin[G8].buyer_address, W1, "G8 unchanged");
    assert.equal(String(byCoin[G7].bnb_amount_raw), milli(1020).toString(), "gen-7 unchanged");

    // top_earner: W4 made no sell once netted (one net buy, -0.020), so it is not in the realized field; W6's
    // excluded sell is not netted into its buy. Everyone else as before.
    const top = await board("top_earner");
    const byWallet = Object.fromEntries(top.map((r) => [r.wallet, r]));
    assert.equal(byWallet[W4], undefined, "a wash pair is not a realized sell");
    assert.equal(byWallet[W6], undefined);
    assert.equal(String(byWallet[W3].profit_raw), (milli(196) - milli(102)).toString());
    assert.equal(String(byWallet[W1].profit_raw), (milli(490) - milli(1020) + milli(294) - milli(1224)).toString());

    // perfect_run (monthly): GW has no sell once netted, so it qualifies; its buy total is 0.020 + 0.050.
    const res = await call(league, `/api/league?${new URLSearchParams({ chainId: String(CHAIN), category: "perfect_run", period: "monthly" })}`);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const run = res.body.items.find((r) => r.campaign_address === GW);
    assert.ok(run, "GW qualifies for perfect_run");
    assert.equal(String(run.buy_total_raw), milli(70).toString());
    assert.equal(Number(run.unique_buyers), 2);

    // The netted SQL directly: one row for the wash transaction (side buy, 0.020, last leg's log index 9).
    const { gen8NettedCurveTradesSql } = await import("./lib/evmGen8LeagueSql.js");
    const { rows } = await db.query(`select side, bnb_amount_raw::text as amt, log_index, block_number, wallet, league_excluded from ${gen8NettedCurveTradesSql("t")} where t.tx_hash = $1`, [WASH_TX]);
    assert.deepEqual(rows, [{ side: "buy", amt: milli(20).toString(), log_index: 9, block_number: "5000", wallet: W4, league_excluded: false }]);
    const mixed = await db.query(`select side, bnb_amount_raw::text as amt, league_excluded from ${gen8NettedCurveTradesSql("t")} where t.tx_hash = $1 order by league_excluded`, [MIXED_TX]);
    assert.deepEqual(mixed.rows, [{ side: "buy", amt: milli(40).toString(), league_excluded: false }, { side: "sell", amt: milli(29).toString(), league_excluded: true }]);
    // Every non-gen-8 row passes through unchanged.
    const g7 = await db.query(`select count(*)::int as n from ${gen8NettedCurveTradesSql("t")} where t.campaign_address = $1`, [G7]);
    assert.equal(g7.rows[0].n, 2);

    // Settlement renders the exact same FROM item (leagueLeaderboard.ts gen8NettedCurveTradesSql).
    const ts = fs.readFileSync(path.join(ROOT, "realtime-indexer/src/rewards/leagueLeaderboard.ts"), "utf8");
    const fn = (name) => {
      const i = ts.indexOf(`export function ${name}(`);
      return ts.slice(i, ts.indexOf("\n}\n", i) + 2).replace(/^export /, "");
    };
    const settlementNetted = new Function(
      `const GEN8_ROW = (a) => \`coalesce(\${a}.venue, '') = 'gen8'\`;\n${fn("gen8TraderNativeRawSql")}\n${fn("gen8NettedCurveTradesSql")}\nreturn gen8NettedCurveTradesSql;`,
    )();
    assert.equal(settlementNetted("t"), gen8NettedCurveTradesSql("t"), "board == settlement");
  } finally {
    setGen8(false);
  }
});

test("wash netting is gen-8 only: without gen-8 config the boards read curve_trades exactly as before", async () => {
  setGen8(false);
  // GW's wash legs are gen-8 rows on a chain without gen-8 config: the plain SQL counts both legs (the pre-gen-8
  // behaviour), which shows the netted FROM item is not used there.
  const hits = await board("biggest_hit");
  const byCoin = Object.fromEntries(hits.map((r) => [r.campaign_address, r]));
  assert.equal(byCoin["0x00000000000000000000000000000000000000a9"].buyer_address, "0x0000000000000000000000000000000000000004");
  assert.equal(String(byCoin["0x00000000000000000000000000000000000000a9"].bnb_amount_raw), milli(980).toString(), "raw curve amount, as before gen-8");
});
