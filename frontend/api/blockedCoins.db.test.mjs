// Blocked coins (Command Center -> Abuse, 2026-10-10) against a throwaway Postgres: the API before the
// migration (no table: nothing blocked, nothing crashes), the migration itself (runs twice, backfills
// publicHidden coins), the shared listing SQL, the admin handlers with their side effects and audit,
// and the public surfaces (coin page 410, War Room, feed, story and share link).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.DBC_THROWAY_PG_PORT ||= "55443";
const { startThrowawayPostgres } = await import("../../scripts/dbc/throwaway-postgres.mjs");
const pg = await startThrowawayPostgres();
process.env.DATABASE_URL = pg.url;
process.env.PG_DISABLE_SSL = "1";
const db = pg.pool;

const MIGRATION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations/20261010_000020_blocked_coins.sql");
const PG_BIN = process.env.DBC_PG_BIN || "/usr/lib/postgresql/14/bin";
function applyMigration() {
  const r = spawnSync(path.join(PG_BIN, "psql"), ["-h", "127.0.0.1", "-p", String(pg.port), "-U", "postgres", "-d", "mwz", "-v", "ON_ERROR_STOP=1", "-f", MIGRATION], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
}

test.after(async () => {
  const { pool } = await import("../server/db.js");
  await pool?.end?.().catch(() => {});
  await pg.stop();
});

await db.query(`
  alter table public.campaign_drafts add column if not exists name text;
  alter table public.campaign_drafts add column if not exists ticker text;
  alter table public.campaign_drafts add column if not exists logo_url text;
  alter table public.campaign_drafts add column if not exists slug text;
  alter table public.campaign_drafts add column if not exists campaign_address text;
  alter table public.campaign_drafts add column if not exists token_address text;
  alter table public.campaign_drafts add column if not exists visibility text not null default 'public';
  alter table public.campaign_drafts add column if not exists status text not null default 'draft';
  alter table public.campaign_drafts add column if not exists created_at timestamptz not null default now();
  create table public.social_posts (
    id bigserial primary key, author_address text not null, body text not null default '', media_url text,
    mentioned_chain_id integer, mentioned_campaign text, mentioned_token text, status smallint not null default 0,
    created_at timestamptz not null default now(), parent_id bigint, quote_of_id bigint, coin_post_id bigint,
    media_urls text[], system_event_key text
  );
  create unique index social_posts_system_event_key_uidx on public.social_posts (system_event_key) where system_event_key is not null;
  create table public.social_post_fires (post_id bigint, author_address text);
  create table public.social_post_reposts (post_id bigint, author_address text, created_at timestamptz default now());
  create table public.user_profiles (address text, display_name text, avatar_url text, updated_at timestamptz);
  create table public.arena_token_imports (
    id bigserial primary key, chain_id integer, token_address text, owner_wallet text, project_owner_wallet text,
    name text, symbol text, status text, image_url text, updated_at timestamptz default now()
  );
  create table public.prepare_mode_notifications (
    id uuid primary key default gen_random_uuid(), wallet_address text not null, event_type text not null default 'launch',
    target_type text not null default 'campaign', target_id text not null default '', title text not null default '',
    body text not null default '', is_read boolean not null default false, read_at timestamptz, dedupe_key text,
    created_at timestamptz not null default now()
  );
  create table public.abuse_reports (id uuid primary key default gen_random_uuid());
  create table public.abuse_audit_events (
    id uuid primary key default gen_random_uuid(), event_type text not null, actor_type text not null,
    actor_id text, actor_email text, subject_id text, subject_email text, old_value text, new_value text,
    metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
    constraint abuse_audit_events_event_type_chk check (event_type in ('PERMISSION_GRANTED', 'PERMISSION_REVOKED', 'UNAUTHORIZED_ACCESS')),
    constraint abuse_audit_events_actor_type_chk check (actor_type in ('admin', 'system'))
  );
`);

const BNB = 56;
const SOL = 101;
const BAD = "0x34c56eb8293ccb285fe9e4facbcd5c6e7f7bfb8d"; // the BNB test coin of 2026-10-10
const BAD_TOKEN = "0x817f6551ee1d0ffc6544f9388d7f3f646bfd0bd7";
const GOOD = "0x00000000000000000000000000000000000000a1";
const GOOD_TOKEN = "0x00000000000000000000000000000000000000a2";
const HIDDEN = "0x00000000000000000000000000000000000000b1";
const SOL_CAMPAIGN = "Bv2EZEznfuHNHcoC5DXJJtJH8x7mAjCUagsPGeXK3Jms";
const SOL_TOKEN = "HENAd3LKca2nV6U9tBx2pLzkib4TsYLpywNhMcVQAwTr";
const CREATOR = "0x1a367016f10b230e28cf1abda2594c47bf60fe34";
const ADMIN = { id: "6b914d8c-db86-4dcd-a4f0-c939dcfb9a70", email: "boss@memewar.zone" };

async function campaign(chainId, address, token, { hidden = false, symbol = "C" } = {}) {
  await db.query(
    `insert into public.campaigns (chain_id, campaign_address, token_address, creator_address, name, symbol, meta, created_block, created_at_chain, launched)
     values ($1, $2, $3, $4, $5, $5, $6::jsonb, 1, now() - interval '1 hour', true)`,
    [chainId, address, token, CREATOR, symbol, JSON.stringify(hidden ? { publicHidden: true } : {})],
  );
}
await campaign(BNB, BAD, BAD_TOKEN, { symbol: "K88BNB" });
await campaign(BNB, GOOD, GOOD_TOKEN, { symbol: "GOOD" });
await campaign(BNB, HIDDEN, null, { hidden: true, symbol: "HID" });
await campaign(SOL, SOL_CAMPAIGN, SOL_TOKEN, { symbol: "SOLC" });

const sql = await import("./lib/publicHiddenSql.js");
const blocked = await import("./lib/blockedCoins.js");
const blockedHandlers = await import("./admin/abuse/blockedCoins.js");

async function visibleCampaigns(chainId) {
  const { rows } = await db.query(
    `select c.campaign_address from public.campaigns c where c.chain_id = $1 and not ${sql.publicHiddenOrBlockedWhere("c")} order by 1`,
    [chainId],
  );
  return rows.map((r) => r.campaign_address);
}

// ── Before the migration ──────────────────────────────────────────────────────────────────────────

test("before the migration: no table means no blocks and the plain publicHidden SQL", async () => {
  assert.equal(await sql.probeBlockedCoinsTable(db), false);
  assert.equal(sql.publicHiddenOrBlockedWhere("c"), sql.publicHiddenWhere("c"));
  assert.equal(sql.notBlockedCoinSql({ chain: "p.mentioned_chain_id", campaign: "p.mentioned_campaign" }), "true");
  assert.deepEqual(await visibleCampaigns(BNB), [GOOD, BAD].sort());
  assert.equal(await blocked.findActiveBlock(db, BNB, BAD), null);
  assert.deepEqual(await blocked.loadActiveBlocks(db, BNB), []);
  // Forced on while the table is missing: the 42P01 is caught, never thrown.
  sql.setBlockedCoinsTablePresent(true);
  try {
    assert.equal(await blocked.findActiveBlock(db, BNB, BAD), null);
    assert.deepEqual(await blocked.loadActiveBlocks(db, BNB), []);
  } finally {
    sql.setBlockedCoinsTablePresent(null);
  }
});

test("before the migration: block and release answer 503, the list is empty", async () => {
  const { handler, calls } = adminHandler();
  const list = await call(handler, "GET", "/api/admin/abuse/blocked-coins?status=all");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.coins, []);
  const post = await call(handler, "POST", "/api/admin/abuse/blocked-coins", { chainId: BNB, address: BAD, kind: "test", mode: "hide", reason: "test coin" });
  assert.equal(post.status, 503);
  assert.equal(post.body.code, "BLOCKED_COINS_SCHEMA_MISSING");
  assert.deepEqual(calls.at(-1), "abuse.manage");
});

// ── The migration ─────────────────────────────────────────────────────────────────────────────────

test("the migration runs twice and backfills each publicHidden coin once", async () => {
  applyMigration();
  applyMigration();
  const { rows } = await db.query(`select chain_id, campaign_address, kind, mode, reason from public.blocked_coins order by id`);
  assert.deepEqual(rows, [{ chain_id: BNB, campaign_address: HIDDEN, kind: "test", mode: "hide", reason: "publicHidden backfill" }]);
  const audit = await db.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname = 'abuse_audit_events_event_type_chk'`);
  assert.match(audit.rows[0].d, /COIN_BLOCKED/);
  assert.match(audit.rows[0].d, /COIN_BLOCK_RELEASED/);
  const rls = await db.query(`select relrowsecurity from pg_class where oid = 'public.blocked_coins'::regclass`);
  assert.equal(rls.rows[0].relrowsecurity, true);
  sql.setBlockedCoinsTablePresent(null);
  assert.equal(await sql.probeBlockedCoinsTable(db), true);
});

test("one active block per coin: a second active row is refused by the index", async () => {
  await db.query(`insert into public.blocked_coins (chain_id, campaign_address, kind, mode, reason) values (1, '0xab', 'test', 'hide', 'one')`);
  await assert.rejects(
    db.query(`insert into public.blocked_coins (chain_id, campaign_address, kind, mode, reason) values (1, '0xab', 'abuse', 'remove', 'two')`),
    (e) => e.code === "23505",
  );
  await db.query(`update public.blocked_coins set released_at = now(), release_reason = 'done' where chain_id = 1`);
  await db.query(`insert into public.blocked_coins (chain_id, campaign_address, kind, mode, reason) values (1, '0xab', 'abuse', 'remove', 'three')`);
  await db.query(`delete from public.blocked_coins where chain_id = 1`);
});

// ── Shared listing SQL ────────────────────────────────────────────────────────────────────────────

test("listing SQL: a blocked coin is out, a released block is back in, Solana keeps case", async () => {
  await db.query(`insert into public.blocked_coins (chain_id, campaign_address, token_address, kind, mode, reason) values ($1, $2, $3, 'abuse', 'hide', 'sql test')`, [BNB, BAD, BAD_TOKEN]);
  assert.deepEqual(await visibleCampaigns(BNB), [GOOD]);
  await db.query(`update public.blocked_coins set released_at = now(), release_reason = 'undo' where chain_id = $1 and campaign_address = $2`, [BNB, BAD]);
  assert.deepEqual(await visibleCampaigns(BNB), [GOOD, BAD].sort());

  // Solana: blocked by the mint only, stored as-is. A lower-cased mint is a different key.
  await db.query(`insert into public.blocked_coins (chain_id, token_address, kind, mode, reason) values ($1, $2, 'test', 'hide', 'lower')`, [SOL, SOL_TOKEN.toLowerCase()]);
  assert.deepEqual(await visibleCampaigns(SOL), [SOL_CAMPAIGN]);
  await db.query(`insert into public.blocked_coins (chain_id, token_address, kind, mode, reason) values ($1, $2, 'test', 'hide', 'exact')`, [SOL, SOL_TOKEN]);
  assert.deepEqual(await visibleCampaigns(SOL), []);
  await db.query(`delete from public.blocked_coins where reason in ('sql test', 'lower', 'exact')`);

  // Event-table form: a trade row on a blocked campaign does not pass.
  await db.query(`insert into public.blocked_coins (chain_id, campaign_address, token_address, kind, mode, reason) values ($1, $2, $3, 'abuse', 'hide', 'event')`, [BNB, BAD, BAD_TOKEN]);
  const ev = await db.query(
    `select x.campaign_address from (values ($1::int, $2::text), ($1::int, $3::text)) as x(chain_id, campaign_address)
      where ${sql.notPublicHiddenOrBlockedCampaignSql("x")}`,
    [BNB, BAD.toUpperCase().replace("0X", "0x"), GOOD],
  );
  assert.deepEqual(ev.rows.map((r) => r.campaign_address), [GOOD]);
  await db.query(`delete from public.blocked_coins where reason = 'event'`);
});

test("hidden key set: blocked coins add their campaign and token keys; finance labels stay test coins only", async () => {
  const { loadPublicHiddenCampaignKeys } = await import("./lib/publicHiddenCampaigns.js");
  await db.query(`insert into public.blocked_coins (chain_id, campaign_address, token_address, kind, mode, reason) values ($1, $2, $3, 'abuse', 'remove', 'keys')`, [BNB, BAD, BAD_TOKEN]);
  const keys = await loadPublicHiddenCampaignKeys(BNB);
  assert.ok(keys.has(`56:${HIDDEN}`) && keys.has(`56:${BAD}`) && keys.has(`56:${BAD_TOKEN}`));
  const testOnly = await loadPublicHiddenCampaignKeys(BNB, { includeBlocked: false });
  assert.deepEqual([...testOnly], [`56:${HIDDEN}`]);

  const { default: hidden } = await import("./campaignsHidden.js");
  const res = await call(hidden, "GET", "/api/campaigns/hidden?chainId=56");
  assert.equal(res.status, 200);
  assert.ok(res.body.campaigns.includes(BAD_TOKEN));
  assert.deepEqual(res.body.blocked.find((b) => b.campaignAddress === BAD), { campaignAddress: BAD, tokenAddress: BAD_TOKEN, mode: "remove" });
  await db.query(`delete from public.blocked_coins where reason = 'keys'`);
});

// ── Admin handlers ────────────────────────────────────────────────────────────────────────────────

function adminHandler({ deny = null } = {}) {
  const calls = [];
  const auth = {
    async requireAbusePermission(req, res, permission) {
      calls.push(permission);
      if (deny && deny.includes(permission)) {
        res.status(403).json({ ok: false, error: "Forbidden", code: "ABUSE_FORBIDDEN" });
        return null;
      }
      return { ...ADMIN, permissions: [permission] };
    },
  };
  return { calls, handler: blockedHandlers.createBlockedCoinsHandlers({ pool: db, auth }) };
}

function call(handler, method, url, body, params = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        resolve({ status: this.statusCode, body: data });
        return this;
      },
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      end(data) {
        let parsed = data;
        try {
          parsed = JSON.parse(String(data ?? ""));
        } catch {
          parsed = String(data ?? "");
        }
        resolve({ status: this.statusCode, body: parsed, headers: this.headers });
      },
    };
    const req = { method, url, originalUrl: url, path: url.split("?")[0].replace(/^\/api/, ""), headers: {}, body: body ?? {}, params, query: {} };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test("admin: block needs abuse.manage, release needs abuse.admin, list and lookup need abuse.view", async () => {
  const { handler, calls } = adminHandler({ deny: ["abuse.manage", "abuse.admin"] });
  assert.equal((await call(handler, "GET", "/api/admin/abuse/blocked-coins")).status, 200);
  assert.equal((await call(handler, "GET", `/api/admin/abuse/blocked-coins/lookup?chainId=56&address=${BAD}`)).status, 200);
  assert.equal((await call(handler, "POST", "/api/admin/abuse/blocked-coins", { chainId: BNB, address: BAD, kind: "test", mode: "hide", reason: "x x x" })).status, 403);
  assert.equal((await call(handler, "POST", "/api/admin/abuse/blocked-coins/1/release", { reason: "x x x" })).status, 403);
  assert.deepEqual(calls, ["abuse.view", "abuse.view", "abuse.manage", "abuse.admin"]);
  assert.equal((await db.query(`select count(*)::int n from public.blocked_coins where released_at is null and chain_id = 56 and campaign_address = $1`, [BAD])).rows[0].n, 0);
});

test("admin: lookup resolves a coin by campaign or token, and an import", async () => {
  const { handler } = adminHandler();
  const byCampaign = await call(handler, "GET", `/api/admin/abuse/blocked-coins/lookup?chainId=56&address=${BAD.toUpperCase().replace("0X", "0x")}`);
  assert.deepEqual(byCampaign.body.coin, {
    chainId: 56, campaignAddress: BAD, tokenAddress: BAD_TOKEN, name: "K88BNB", symbol: "K88BNB", creatorAddress: CREATOR,
    logoUrl: null, launched: true, graduated: false, imported: false,
  });
  assert.equal(byCampaign.body.activeBlock, null);
  const byToken = await call(handler, "GET", `/api/admin/abuse/blocked-coins/lookup?chainId=56&address=${BAD_TOKEN}`);
  assert.equal(byToken.body.coin.campaignAddress, BAD);
  await db.query(`insert into public.arena_token_imports (chain_id, token_address, owner_wallet, name, symbol, status) values (56, '0x00000000000000000000000000000000000000c1', '0xowner', 'Imp', 'IMP', 'passed')`);
  const imp = await call(handler, "GET", "/api/admin/abuse/blocked-coins/lookup?chainId=56&address=0x00000000000000000000000000000000000000C1");
  assert.equal(imp.body.coin.imported, true);
  assert.equal(imp.body.coin.campaignAddress, null);
  const none = await call(handler, "GET", "/api/admin/abuse/blocked-coins/lookup?chainId=56&address=0x00000000000000000000000000000000000000ee");
  assert.deepEqual(none.body, { ok: true, coin: null, activeBlock: null });
  assert.equal((await call(handler, "GET", "/api/admin/abuse/blocked-coins/lookup?chainId=56&address=nope")).status, 400);
});

let blockId;
let postIds;

test("admin: block soft-deletes the coin's posts and replies, reads its launch notification, audits; 409 on a second block", async () => {
  const insert = async (values) =>
    (await db.query(
      `insert into public.social_posts (author_address, body, mentioned_chain_id, mentioned_campaign, mentioned_token, parent_id, system_event_key, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      values,
    )).rows[0].id;
  const deploy = await insert([CREATOR, "launched", 56, BAD, BAD_TOKEN, null, `deploy:56:${BAD}`, 0]);
  const reply = await insert(["0xfan", "nice", null, null, null, deploy, null, 0]);
  const mention = await insert(["0xfan", "buy $K88", 56, BAD, null, null, null, 0]);
  const mentionByToken = await insert(["0xfan2", "token", 56, null, BAD_TOKEN.toUpperCase().replace("0X", "0x"), null, null, 0]);
  const deletedBefore = await insert(["0xfan", "gone already", 56, BAD, null, null, null, 2]);
  const other = await insert(["0xfan", "good coin", 56, GOOD, null, null, null, 0]);
  postIds = { deploy, reply, mention, mentionByToken, deletedBefore, other };
  await db.query(
    `insert into public.prepare_mode_notifications (wallet_address, dedupe_key) values ($1, $2), ($1, $3)`,
    [CREATOR, `coin:launch:56:${BAD}`, `coin:launch:56:${GOOD}`],
  );

  const { handler } = adminHandler();
  const bad = await call(handler, "POST", "/api/admin/abuse/blocked-coins", { chainId: BNB, address: BAD, kind: "evil", mode: "hide", reason: "x x x" });
  assert.equal(bad.status, 400);
  const noReason = await call(handler, "POST", "/api/admin/abuse/blocked-coins", { chainId: BNB, address: BAD, kind: "test", mode: "hide", reason: " " });
  assert.equal(noReason.status, 400);
  const unknown = await call(handler, "POST", "/api/admin/abuse/blocked-coins", { chainId: BNB, address: "0x00000000000000000000000000000000000000ee", kind: "test", mode: "hide", reason: "x x x" });
  assert.equal(unknown.status, 404);

  const report = (await db.query(`insert into public.abuse_reports default values returning id`)).rows[0].id;
  const res = await call(handler, "POST", "/api/admin/abuse/blocked-coins", {
    chainId: BNB, address: BAD_TOKEN, kind: "test", mode: "remove", reason: "K88 test coin", abuseReportId: report,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const coin = res.body.coin;
  blockId = coin.id;
  assert.deepEqual(
    { ...coin, id: "x", createdAt: "x" },
    {
      id: "x", chainId: 56, campaignAddress: BAD, tokenAddress: BAD_TOKEN, name: "K88BNB", symbol: "K88BNB", kind: "test", mode: "remove",
      reason: "K88 test coin", abuseReportId: report, createdByEmail: ADMIN.email, createdAt: "x", releasedAt: null, releasedByEmail: null, releaseReason: null,
    },
  );

  const statuses = Object.fromEntries((await db.query(`select id, status from public.social_posts`)).rows.map((r) => [String(r.id), r.status]));
  assert.equal(statuses[deploy], 2);
  assert.equal(statuses[reply], 2);
  assert.equal(statuses[mention], 2);
  assert.equal(statuses[mentionByToken], 2);
  assert.equal(statuses[deletedBefore], 2);
  assert.equal(statuses[other], 0);
  const side = (await db.query(`select side_effects, created_by from public.blocked_coins where id = $1`, [blockId])).rows[0];
  assert.deepEqual(side.side_effects.socialPostIds.map(Number).sort((a, b) => a - b), [deploy, reply, mention, mentionByToken].map(Number).sort((a, b) => a - b));
  assert.equal(side.created_by, ADMIN.id);
  const notes = (await db.query(`select dedupe_key, is_read from public.prepare_mode_notifications order by dedupe_key`)).rows;
  assert.deepEqual(notes, [
    { dedupe_key: `coin:launch:56:${GOOD}`, is_read: false },
    { dedupe_key: `coin:launch:56:${BAD}`, is_read: true },
  ].sort((a, b) => a.dedupe_key.localeCompare(b.dedupe_key)));
  const audit = (await db.query(`select event_type, actor_id, actor_email, subject_id, new_value, metadata from public.abuse_audit_events`)).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].event_type, "COIN_BLOCKED");
  assert.equal(audit[0].subject_id, `blocked_coin:${blockId}`);
  assert.equal(audit[0].new_value, "test:remove");
  assert.equal(audit[0].metadata.hiddenPosts, 4);

  const again = await call(handler, "POST", "/api/admin/abuse/blocked-coins", { chainId: BNB, address: BAD, kind: "abuse", mode: "hide", reason: "again" });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "COIN_ALREADY_BLOCKED");
  assert.equal(again.body.activeBlock.id, blockId);

  const lookup = await call(handler, "GET", `/api/admin/abuse/blocked-coins/lookup?chainId=56&address=${BAD}`);
  assert.equal(lookup.body.activeBlock.id, blockId);
  const list = await call(handler, "GET", "/api/admin/abuse/blocked-coins");
  assert.ok(list.body.coins.some((c) => c.id === blockId));
  assert.ok(list.body.coins.some((c) => c.campaignAddress === HIDDEN && c.reason === "publicHidden backfill"));
});

// ── Public surfaces while the block is active (mode remove) ──────────────────────────────────────

test("coin page: a removed coin answers 410 by campaign or token; hide is reported; others untouched", async () => {
  blocked.clearBlockedCoinCache();
  const { default: coinPage } = await import("./coinPage.js");
  const byToken = await call(coinPage, "GET", `/api/coin-page?chainId=56&token=${BAD_TOKEN}`);
  assert.equal(byToken.status, 410);
  assert.equal(byToken.body.removed, true);
  const byCampaign = await call(coinPage, "GET", `/api/coin-page?chainId=56&token=${BAD}&blockOnly=1`);
  assert.equal(byCampaign.status, 410);
  const good = await call(coinPage, "GET", `/api/coin-page?chainId=56&token=${GOOD_TOKEN}&blockOnly=1`);
  assert.deepEqual({ status: good.status, body: good.body }, { status: 200, body: { block: null } });
  await db.query(`update public.blocked_coins set mode = 'hide' where id = $1`, [blockId]);
  blocked.clearBlockedCoinCache();
  const hidden = await call(coinPage, "GET", `/api/coin-page?chainId=56&token=${BAD_TOKEN}&blockOnly=1`);
  assert.deepEqual({ status: hidden.status, body: hidden.body }, { status: 200, body: { block: { mode: "hide" } } });
  await db.query(`update public.blocked_coins set mode = 'remove' where id = $1`, [blockId]);
  blocked.clearBlockedCoinCache();
});

test("War Room: the blocked coin is not in the list, the search or the detail", async () => {
  const { default: warRoom } = await import("./warRoom.js");
  const list = await call(warRoom, "GET", "/api/war-room?chainId=56&mode=new");
  assert.equal(list.status, 200);
  const listed = list.body.items.map((i) => String(i.campaignAddress).toLowerCase());
  assert.ok(listed.includes(GOOD));
  assert.ok(!listed.includes(BAD));
  assert.ok(!listed.includes(HIDDEN));
  const search = await call(warRoom, "GET", "/api/war-room?chainId=56&search=K88");
  assert.equal(search.body.items.length, 0);
  const detail = await call(warRoom, "GET", `/api/war-room?chainId=56&campaignAddress=${BAD}`);
  assert.equal(detail.status, 404);
  const goodDetail = await call(warRoom, "GET", `/api/war-room?chainId=56&campaignAddress=${GOOD}`);
  assert.equal(goodDetail.status, 200);
});

test("feed: launches, drafts and posts with the blocked coin's card are left out", async () => {
  const timeline = await import("./lib/feedTimeline.js");
  const deploys = await timeline.loadDeployEvents({ limit: 50 });
  assert.ok(deploys.some((d) => d.campaignAddress === GOOD));
  assert.ok(!deploys.some((d) => d.campaignAddress === BAD));
  await db.query(
    `insert into public.campaign_drafts (chain_id, creator_wallet, name, ticker, campaign_address, token_address) values (56, $1, 'bad', 'K88', $2, $3), (56, $1, 'good', 'G', $4, null), (56, $1, 'plain', 'P', null, null)`,
    [CREATOR, BAD, BAD_TOKEN, GOOD],
  );
  const drafts = await timeline.loadDraftEvents({ limit: 50 });
  assert.deepEqual(drafts.map((d) => d.name).sort(), ["good", "plain"]);

  // A post written after the block that carries the coin card: not in the feed, not on its own page.
  const late = (await db.query(`insert into public.social_posts (author_address, body, mentioned_chain_id, mentioned_campaign) values ('0xlate', 'late', 56, $1) returning id`, [BAD])).rows[0].id;
  const { default: posts } = await import("./feed/posts.js");
  const one = await call(posts, "GET", `/api/feed/posts/${late}`);
  assert.equal(one.status, 404);
  const goodOne = await call(posts, "GET", `/api/feed/posts/${postIds.other}`);
  assert.equal(goodOne.status, 200);
  const social = await import("./lib/socialTimeline.js");
  const own = await social.loadPostEvents(["0xlate", "0xfan"]);
  assert.ok(own.some((p) => String(p.id ?? p.postId ?? "").includes(String(postIds.other)) || p.body === "good coin"));
  assert.ok(!own.some((p) => p.body === "late"));
  await db.query(`delete from public.social_posts where id = $1`, [late]);
});

test("story: no story, no card and a plain 404 share page for the blocked coin", async () => {
  const story = await import("./story.js");
  assert.equal(await story.loadStory(56, BAD_TOKEN), null);
  const share = await call(story.handleSharePage, "GET", `/s/56/${BAD_TOKEN}`, undefined, { chainId: "56", token: BAD_TOKEN });
  assert.equal(share.status, 404);
  assert.doesNotMatch(String(share.body), /K88/);
  assert.doesNotMatch(String(share.body), /story\/56/);
});

// ── Release ───────────────────────────────────────────────────────────────────────────────────────

test("admin: release puts back exactly the posts the block took down, audits, and frees the coin", async () => {
  const { handler } = adminHandler();
  assert.equal((await call(handler, "POST", `/api/admin/abuse/blocked-coins/${blockId}/release`, { reason: "" })).status, 400);
  assert.equal((await call(handler, "POST", "/api/admin/abuse/blocked-coins/999999/release", { reason: "not there" })).status, 404);
  const res = await call(handler, "POST", `/api/admin/abuse/blocked-coins/${blockId}/release`, { reason: "it was a mistake" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.coin.releaseReason, "it was a mistake");
  assert.equal(res.body.coin.releasedByEmail, ADMIN.email);
  assert.ok(res.body.coin.releasedAt);
  const statuses = Object.fromEntries((await db.query(`select id, status from public.social_posts`)).rows.map((r) => [String(r.id), r.status]));
  for (const id of [postIds.deploy, postIds.reply, postIds.mention, postIds.mentionByToken]) assert.equal(statuses[id], 0);
  assert.equal(statuses[postIds.deletedBefore], 2, "a post deleted before the block stays deleted");
  const audit = (await db.query(`select event_type, old_value, new_value from public.abuse_audit_events order by created_at`)).rows;
  assert.deepEqual(audit.map((a) => a.event_type), ["COIN_BLOCKED", "COIN_BLOCK_RELEASED"]);
  assert.equal(audit[1].old_value, "test:remove");

  assert.equal((await call(handler, "POST", `/api/admin/abuse/blocked-coins/${blockId}/release`, { reason: "again" })).status, 409);
  const released = await call(handler, "GET", "/api/admin/abuse/blocked-coins?status=released");
  assert.deepEqual(released.body.coins.map((c) => c.id), [blockId]);
  assert.deepEqual(await visibleCampaigns(BNB), [GOOD, BAD].sort());
  blocked.clearBlockedCoinCache();
  const { default: coinPage } = await import("./coinPage.js");
  const page = await call(coinPage, "GET", `/api/coin-page?chainId=56&token=${BAD_TOKEN}&blockOnly=1`);
  assert.deepEqual(page.body, { block: null });
  // A fresh block works again after the release.
  const again = await call(handler, "POST", "/api/admin/abuse/blocked-coins", { chainId: BNB, address: BAD, kind: "abuse", mode: "hide", reason: "for real now" });
  assert.equal(again.status, 200);
});
