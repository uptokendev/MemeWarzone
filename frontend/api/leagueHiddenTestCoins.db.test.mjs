// Live league boards follow the settlement rule for hidden test coins (founder, 2026-10-05): the real
// /api/league handler against a throwaway Postgres. Per-coin boards skip the hidden coin, top_earner
// does not count its trades, the recruiter board counts neither its volume nor its credit, and the
// MWL board leaves the coin out. Same fixtures as the indexer's settlement test
// (realtime-indexer/src/tests/hiddenTestCoinLeagues.integration.test.ts).
import assert from "node:assert/strict";
import test from "node:test";

process.env.DBC_THROWAY_PG_PORT ||= "55437";
const { startThrowawayPostgres } = await import("../../scripts/dbc/throwaway-postgres.mjs");
const pg = await startThrowawayPostgres();
process.env.DATABASE_URL = pg.url;
process.env.PG_DISABLE_SSL = "1";
// The live week has no rows in a throwaway database: read all indexed activity, as staging does.
process.env.STAGING_LEAGUE_ALLTIME_FALLBACK = "1";
const db = pg.pool;

test.after(async () => {
  const { pool } = await import("../server/db.js");
  await pool?.end?.().catch(() => {});
  await pg.stop();
});

await db.query(`
  alter table public.recruiters add column if not exists metadata jsonb not null default '{}'::jsonb;
  create table if not exists public.votes (
    chain_id integer not null, campaign_address text not null, voter_address text not null,
    amount_raw numeric not null default 0, block_number bigint not null default 0,
    block_timestamp timestamptz not null, status text not null default 'confirmed'
  );
  create table if not exists public.wallet_squad_memberships (
    recruiter_id bigint not null, wallet_address text not null, member_role text,
    is_active boolean not null default true, joined_at timestamptz not null default now()
  );
  create table if not exists public.arena_league_seasons (
    id text primary key, chain_id integer not null, year integer, month integer, active boolean not null default true,
    starts_at timestamptz, ends_at timestamptz, finalized_at timestamptz, created_at timestamptz not null default now()
  );
  create table if not exists public.arena_league_entries (
    season_id text not null, token_address text not null, token_name text, symbol text, points integer not null default 0,
    wins integer not null default 0, losses integer not null default 0, finished_fights integer not null default 0, checkin_streak integer
  );
`);

const CHAIN = 97;
const at = (h) => new Date(Date.now() - 3 * 86_400_000 + h * 3_600_000).toISOString();
const BNB = 10n ** 18n;
const REAL = "0x00000000000000000000000000000000000000a1";
const REAL2 = "0x00000000000000000000000000000000000000a2";
const TEST = "0x00000000000000000000000000000000000000b1";
const W1 = "0x0000000000000000000000000000000000000001";
const W2 = "0x0000000000000000000000000000000000000002";
const W3 = "0x0000000000000000000000000000000000000003";
const CREATOR_REAL = "0x00000000000000000000000000000000000000d1";
const CREATOR_TEST = "0x00000000000000000000000000000000000000d2";

async function campaign(chainId, address, creator, hidden, token = null) {
  await db.query(
    `insert into public.campaigns (chain_id, campaign_address, token_address, creator_address, name, symbol, meta, created_block, created_at_chain)
     values ($1, $2, $3, $4, $5, $5, $6::jsonb, 1, $7)`,
    [chainId, address, token, creator, address.slice(-2), JSON.stringify(hidden ? { publicHidden: true } : {}), at(0)],
  );
}
let n = 0;
async function trade(chainId, campaignAddress, wallet, side, amount, hour) {
  n += 1;
  await db.query(
    `insert into public.curve_trades (chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet, token_amount_raw, bnb_amount_raw)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)`,
    [chainId, campaignAddress, `0x${n.toString(16).padStart(64, "0")}`, n, 100 + n, at(hour), side, wallet, amount.toString()],
  );
}

await campaign(CHAIN, REAL, CREATOR_REAL, false);
await campaign(CHAIN, REAL2, CREATOR_REAL, false);
await campaign(CHAIN, TEST, CREATOR_TEST, true);
await trade(CHAIN, TEST, W1, "buy", 5n * BNB, 1);
await trade(CHAIN, REAL, W2, "buy", 3n * BNB, 2);
await trade(CHAIN, REAL2, W3, "buy", 2n * BNB, 3);
await trade(CHAIN, TEST, W1, "sell", 10n * BNB, 4);
await trade(CHAIN, REAL2, W1, "buy", 1n * BNB, 5);
await trade(CHAIN, REAL, W2, "sell", 4n * BNB, 6);
for (let i = 0; i < 10; i++) await db.query(`insert into public.votes (chain_id, campaign_address, voter_address, block_timestamp) values ($1, $2, $3, $4)`, [CHAIN, TEST, `0x${String(i).padStart(40, "e")}`, at(7)]);
for (let i = 0; i < 2; i++) await db.query(`insert into public.votes (chain_id, campaign_address, voter_address, block_timestamp) values ($1, $2, $3, $4)`, [CHAIN, REAL, `0x${String(i).padStart(40, "f")}`, at(8)]);

const { default: league } = await import("./league.js");

async function get(query) {
  const url = `/api/league?${new URLSearchParams(query)}`;
  const res = {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end(text) { if (text != null) { try { this.body = JSON.parse(String(text)); } catch { this.body = text; } } },
  };
  await league({ method: "GET", url, query, headers: {} }, res);
  return res;
}

test("biggest_hit board: the hidden coin is not in the field, the real coins move up", async () => {
  const res = await get({ chainId: String(CHAIN), category: "biggest_hit", period: "weekly" });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.items.map((r) => [r.buyer_address, r.campaign_address]), [[W2, REAL], [W3, REAL2]]);
});

test("top_earner board: trades on the hidden coin count for nothing", async () => {
  const res = await get({ chainId: String(CHAIN), category: "top_earner", period: "weekly" });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.items[0].wallet, W2, "W1 would lead with +4 BNB counting the test coin");
  assert.equal(res.body.items.find((r) => r.wallet === W1), undefined, "W1 has no sell on a real coin and no profit: not in the field");
});

test("crowd_favorite board: votes on the hidden coin are not in the field", async () => {
  const res = await get({ chainId: String(CHAIN), category: "crowd_favorite", period: "weekly" });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.items.map((r) => r.campaign_address), [REAL]);
});

test("recruiter board: hidden-coin volume and credit count for nothing", async () => {
  process.env.BNB_USD_PRICE = "600";
  process.env.SOL_USD_PRICE = "150";
  process.env.ETH_USD_PRICE = "3000";
  const recent = (ms) => new Date(Date.now() - ms).toISOString();
  await campaign(56, REAL, CREATOR_REAL, false);
  await campaign(56, TEST, CREATOR_TEST, true);
  const { rows: [epoch] } = await db.query(`insert into public.epochs (chain_id, epoch_type, start_at, end_at) values (56, 'weekly', now() - interval '7 days', now() + interval '7 days') returning id`);
  const { rows: [r1] } = await db.query(`insert into public.recruiters (wallet_address, code) values ('0x00000000000000000000000000000000000000f1', 'testonly') returning id`);
  const { rows: [r2] } = await db.query(`insert into public.recruiters (wallet_address, code) values ('0x00000000000000000000000000000000000000f2', 'real') returning id`);
  const L1 = "0x00000000000000000000000000000000000000e1";
  const L2 = "0x00000000000000000000000000000000000000e2";
  await db.query(`insert into public.wallet_recruiter_links (wallet_address, recruiter_id, linked_at) values ($1, $2, now() - interval '30 days'), ($3, $4, now() - interval '30 days')`, [L1, r1.id, L2, r2.id]);
  const t = async (campaignAddress, wallet, amount, ms) => {
    n += 1;
    await db.query(
      `insert into public.curve_trades (chain_id, campaign_address, tx_hash, log_index, block_number, block_time, side, wallet, token_amount_raw, bnb_amount_raw)
       values (56, $1, $2, $3, $4, $5, 'buy', $6, 1, $7)`,
      [campaignAddress, `0x${n.toString(16).padStart(64, "0")}`, n, 100 + n, recent(ms), wallet, amount.toString()],
    );
  };
  await t(TEST, L1, 50n * BNB, 3000);
  await t(REAL, L2, 1n * BNB, 2000);
  await t(TEST, L2, 9n * BNB, 1500);
  const reward = (wallet, campaignAddress, amount, k) => db.query(
    `insert into public.reward_events (chain_id, tx_hash, log_index, block_number, occurred_at, epoch_id, wallet_address, campaign_address, route_kind, route_profile, recruiter_amount, raw_amount, source_contract)
     values (56, $1, 0, 1, $2, $3, $4, $5, 'trade', 'standard', $6, 0, '0x')`,
    [`0xre${k}`, recent(1000 + k), epoch.id, wallet, campaignAddress, amount.toString()],
  );
  await reward(L1, TEST, BNB, 1);
  await reward(L2, REAL, BNB / 100n, 2);
  await reward(L2, TEST, BNB, 3);
  const res = await get({ category: "recruiter_league", period: "weekly", chainId: "56", limit: "50" });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const real = res.body.items.find((r) => r.code === "real");
  const testOnly = res.body.items.find((r) => r.code === "testonly");
  assert.ok(real, JSON.stringify(res.body.items));
  assert.equal(Number(real.referredVolumeUsd ?? real.referred_volume_usd), 600, "the 9 BNB on the test coin is not referred volume");
  assert.equal(Number(real.epochEarnedUsd ?? real.epoch_earned_usd), 6, "the 1 BNB recruiter slice from the test coin is not earnings");
  assert.ok(!testOnly || Number(testOnly.referredVolumeUsd ?? testOnly.referred_volume_usd ?? 0) === 0, "the test-coin-only network has no volume");
});
