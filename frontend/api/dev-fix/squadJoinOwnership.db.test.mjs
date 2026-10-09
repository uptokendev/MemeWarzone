// Squad joins need proof of wallet ownership and a per-IP rate (founder, 2026-10-09: recruiter
// 128 got 120 scripted wallets in 6 minutes, one every ~2.5 s, through /api/attribution/wallet-connect,
// which took any walletAddress from the body). Runs the real handler against a throwaway Postgres.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { startThrowawayPostgres } from "../../../scripts/dbc/throwaway-postgres.mjs";
import { hashFeedSessionToken } from "../lib/feedSessionToken.js";

const pg = await startThrowawayPostgres();
process.env.DATABASE_URL = pg.url;
process.env.PG_DISABLE_SSL = "1";
process.env.SQUAD_JOIN_LIMIT_PER_IP = "3";
process.env.SQUAD_JOIN_LIMIT_WINDOW_MINUTES = "60";
const { attributionWalletConnect } = await import("./attribution.js");
const { pool } = await import("../../server/db.js");

test.after(async () => {
  await pool.end().catch(() => {});
  await pg.stop();
});

await pg.pool.query(`
  alter table public.recruiters add column if not exists metadata jsonb not null default '{}'::jsonb;
  alter table public.recruiters add column if not exists squad_image_url text;
  alter table public.recruiters add column if not exists closed_at timestamptz;
  create unique index if not exists wrl_active_wallet on public.wallet_recruiter_links (wallet_address) where is_active;
  create table if not exists public.wallet_profiles (wallet_address text primary key, updated_at timestamptz not null default now());
  create table if not exists public.wallet_attribution_states (wallet_address text primary key, recruiter_id bigint, recruiter_link_state text, squad_state text, has_activity boolean, locked_at timestamptz);
  create table if not exists public.wallet_risk_profiles (wallet_address text primary key, cluster_id text);
  create table if not exists public.wallet_referral_attribution_windows (
    id bigint generated always as identity primary key, wallet_address text, recruiter_id bigint not null,
    client_fingerprint text, session_token text, metadata jsonb, captured_at timestamptz not null default now(),
    expires_at timestamptz not null, consumed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table if not exists public.wallet_squad_memberships (
    wallet_address text not null, recruiter_id bigint not null, member_role text, link_source text,
    is_active boolean not null default true, joined_at timestamptz not null default now(),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create unique index if not exists wsm_active_wallet on public.wallet_squad_memberships (wallet_address) where is_active;
  create table if not exists public.social_feed_sessions (
    token_hash text primary key, wallet_address text not null, expires_at timestamptz not null,
    revoked_at timestamptz, last_used_at timestamptz
  );
`);

const { rows: [recruiter] } = await pg.pool.query(
  `insert into public.recruiters (wallet_address, code) values ('0x00000000000000000000000000000000000000aa', 'sq') returning id`,
);

const evm = () => `0x${crypto.randomBytes(20).toString("hex")}`;

async function signIn(wallet) {
  const token = crypto.randomBytes(32).toString("hex");
  await pg.pool.query(
    `insert into public.social_feed_sessions (token_hash, wallet_address, expires_at) values ($1, $2, now() + interval '30 days')`,
    [hashFeedSessionToken(token), wallet],
  );
  return token;
}

async function openWindow(sessionToken) {
  await pg.pool.query(
    `insert into public.wallet_referral_attribution_windows (recruiter_id, session_token, expires_at) values ($1, $2, now() + interval '30 days')`,
    [recruiter.id, sessionToken],
  );
}

async function connect(body, ip = "203.0.113.1") {
  const req = { method: "POST", body, headers: { "x-real-ip": ip } };
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[k] = v; },
    end(b) { this.body = String(b || ""); },
  };
  await attributionWalletConnect(req, res);
  return { status: res.statusCode, json: JSON.parse(res.body || "{}") };
}

const memberCount = async (wallet) =>
  Number((await pg.pool.query(`select count(*)::int as n from public.wallet_squad_memberships where wallet_address = $1 and is_active`, [wallet])).rows[0].n);

const auth = (wallet, token) => ({ action: "squad_join", walletAddress: wallet, chainId: 56, nonce: "session", message: "", signature: `session:${token}` });

test("no proof of ownership: nothing is linked and the referral window stays open", async () => {
  const wallet = evm();
  const window = `w-${crypto.randomUUID()}`;
  await openWindow(window);
  const { status, json } = await connect({ walletAddress: wallet, sessionToken: window, memberRole: "trader" });
  assert.equal(status, 200);
  assert.equal(json.needsSignIn, true);
  assert.equal(json.code, "SIGN_IN_REQUIRED");
  assert.equal(await memberCount(wallet), 0);
  const { rows } = await pg.pool.query(`select consumed_at from public.wallet_referral_attribution_windows where session_token = $1`, [window]);
  assert.equal(rows[0].consumed_at, null, "the join can retry after sign-in");
});

test("a sign-in for another wallet does not link this one", async () => {
  const wallet = evm();
  const token = await signIn(evm());
  const window = `w-${crypto.randomUUID()}`;
  await openWindow(window);
  const { status, json } = await connect({ walletAddress: wallet, sessionToken: window, memberRole: "trader", auth: auth(wallet, token) });
  assert.equal(status, 401);
  assert.equal(json.code, "WALLET_MISMATCH");
  assert.equal(await memberCount(wallet), 0);
});

test("a made-up session token does not link", async () => {
  const wallet = evm();
  const window = `w-${crypto.randomUUID()}`;
  await openWindow(window);
  const { status } = await connect({ walletAddress: wallet, sessionToken: window, memberRole: "trader", auth: auth(wallet, "deadbeef") });
  assert.equal(status, 401);
  assert.equal(await memberCount(wallet), 0);
});

async function signedJoin(ip) {
  const wallet = evm();
  const window = `w-${crypto.randomUUID()}`;
  await openWindow(window);
  const result = await connect({ walletAddress: wallet, sessionToken: window, memberRole: "trader", auth: auth(wallet, await signIn(wallet)) }, ip);
  return { ...result, wallet, window };
}

test("the wallet's own sign-in links it; past the per-IP rate the next join from that IP waits", async () => {
  // 3 per 60 minutes in this test (SQUAD_JOIN_LIMIT_PER_IP).
  for (let i = 0; i < 3; i += 1) {
    const { status, wallet } = await signedJoin("198.51.100.7");
    assert.equal(status, 200);
    assert.equal(await memberCount(wallet), 1, `join ${i + 1} is linked`);
  }
  const { status, json, wallet, window } = await signedJoin("198.51.100.7");
  assert.equal(status, 429);
  assert.equal(json.code, "SQUAD_JOIN_RATE_LIMITED");
  assert.equal(await memberCount(wallet), 0, "the fourth join from that IP is not linked");
  const { rows } = await pg.pool.query(`select consumed_at from public.wallet_referral_attribution_windows where session_token = $1`, [window]);
  assert.equal(rows[0].consumed_at, null, "its window stays open for a later retry");
});

test("a script on one IP cannot lock the recruiter out: a join from another IP still links", async () => {
  const { status, wallet } = await signedJoin("192.0.2.44");
  assert.equal(status, 200);
  assert.equal(await memberCount(wallet), 1);
});
