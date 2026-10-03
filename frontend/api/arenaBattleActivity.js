/**
 * Battle page API (UI redesign phase 4b). New routes only; existing arena routes are untouched.
 *
 *   GET  /api/arena/battles/:id/activity   confirmed boosts, free votes per 10 min, top supporters, boost totals
 *   GET  /api/arena/battles/:id/comments   visible comments, newest first
 *   POST /api/arena/battles/:id/comments   signed `arena_battle_comment` (lines `Battle:` and `Comment:`)
 *
 * Reads arena_battles and arena_contest_actions (read-only) and the new arena_battle_comments table.
 */
import { pool } from "../server/db.js";
import { json, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { createFeedSessionAuth } from "./lib/feedSessionAuth.js";

const feedSession = createFeedSessionAuth({ pool });
import {
  BATTLE_COMMENT_RATE,
  buildActivity,
  buildBoostSummary,
  buildSupporters,
  commentFromRow,
  nativeDecimals,
  normalizeBattleComment,
} from "./lib/arenaBattleActivity.js";

const COMMENT_CHAINS = new Set([56, 97, 101, 4663, 46630]);

function isSchemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function battleIdFrom(raw) {
  const id = decodeURIComponent(String(raw || "")).trim();
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(id) ? id : "";
}

async function loadBattle(battleId) {
  const { rows } = await pool.query(`select id, chain_id from public.arena_battles where id = $1 limit 1`, [battleId]);
  return rows[0] || null;
}

async function handleActivity(res, battleId) {
  const battle = await loadBattle(battleId);
  if (!battle) return json(res, 404, { error: "Battle not found", code: "BATTLE_NOT_FOUND" });
  const decimals = nativeDecimals(battle.chain_id);
  const [boosts, voteBuckets, supporters, summary] = await Promise.all([
    pool.query(
      `select id, side, wallet, boost_units, gross_native_raw::text as gross_native_raw, coalesce(confirmed_at, created_at) as at
         from public.arena_contest_actions
        where battle_id = $1 and action_type = 'boost' and confirmed_at is not null
        order by coalesce(confirmed_at, created_at) desc
        limit 30`,
      [battleId],
    ),
    pool.query(
      `select side, floor(extract(epoch from created_at) / 600)::bigint as bucket, count(*)::int as n
         from public.arena_contest_actions
        where battle_id = $1 and action_type = 'free_vote' and created_at > now() - interval '48 hours'
        group by side, bucket
        order by bucket desc
        limit 30`,
      [battleId],
    ),
    pool.query(
      `select wallet, side, count(*)::int as boosts, sum(gross_native_raw)::text as gross_native_raw
         from public.arena_contest_actions
        where battle_id = $1 and action_type = 'boost' and confirmed_at is not null
        group by wallet, side
        order by sum(gross_native_raw) desc nulls last
        limit 20`,
      [battleId],
    ),
    pool.query(
      `select side, count(*)::int as boosts, sum(gross_native_raw)::text as gross_native_raw, sum(pool_native_raw)::text as pool_native_raw
         from public.arena_contest_actions
        where battle_id = $1 and action_type = 'boost' and confirmed_at is not null
        group by side`,
      [battleId],
    ),
  ]);
  return json(res, 200, {
    battleId,
    chainId: Number(battle.chain_id),
    activity: buildActivity({ boosts: boosts.rows, voteBuckets: voteBuckets.rows, decimals }),
    supporters: buildSupporters(supporters.rows, decimals),
    boosts: buildBoostSummary(summary.rows, decimals),
  });
}

async function readComments(battleId) {
  const { rows } = await pool.query(
    `select c.id, c.author_wallet, c.body, c.created_at, v.side
       from public.arena_battle_comments c
       left join lateral (
         select a.side from public.arena_contest_actions a
          where a.battle_id = c.battle_id and a.wallet = c.author_wallet and a.action_type = 'free_vote'
          order by a.created_at asc limit 1
       ) v on true
      where c.battle_id = $1 and c.status = 0
      order by c.created_at desc
      limit 100`,
    [battleId],
  );
  return rows.map(commentFromRow);
}

async function handleCommentsGet(res, battleId) {
  try {
    return json(res, 200, { battleId, comments: await readComments(battleId) });
  } catch (error) {
    if (isSchemaMissing(error)) return json(res, 200, { battleId, comments: [], unavailable: true });
    throw error;
  }
}

async function handleCommentCreate(req, res, battleId) {
  const body = await readJson(req);
  const checked = normalizeBattleComment(body.body);
  if (!checked.ok) return json(res, 400, { error: checked.error, code: checked.code });
  // With a feed session (one signature per 30 days) the wallet comes from the session.
  const bearer = /^Bearer\s+\S+/i.test(String(req.headers?.authorization || ""));
  const session = bearer ? await feedSession.requireSession(req, res) : null;
  if (bearer && !session) return;
  const chainId = session ? Number(session.chainId) : Number(body.chainId || body.auth?.chainId || 0);
  if (!COMMENT_CHAINS.has(chainId)) return json(res, 400, { error: "Unsupported wallet chain", code: "BATTLE_COMMENT_CHAIN" });
  const battle = await loadBattle(battleId);
  if (!battle) return json(res, 404, { error: "Battle not found", code: "BATTLE_NOT_FOUND" });

  const verified = session ? { walletAddress: session.walletAddress } : await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth,
    expectedWallet: body.walletAddress || body.auth?.walletAddress,
    chainId,
    action: "arena_battle_comment",
    routeLabel: "arena/battles/comments",
    extraLines: [`Battle: ${battleId}`, `Comment: ${checked.text}`],
    strict: true,
  });
  if (!verified) return;

  const recent = await pool.query(
    `select count(*)::int as n from public.arena_battle_comments
      where author_wallet = $1 and created_at > now() - ($2 || ' minutes')::interval`,
    [verified.walletAddress, String(BATTLE_COMMENT_RATE.windowMinutes)],
  );
  if (Number(recent.rows[0]?.n || 0) >= BATTLE_COMMENT_RATE.count) {
    return json(res, 429, { error: `At most ${BATTLE_COMMENT_RATE.count} comments per ${BATTLE_COMMENT_RATE.windowMinutes} minutes.`, code: "BATTLE_COMMENT_RATE_LIMIT" });
  }
  const { rows } = await pool.query(
    `insert into public.arena_battle_comments (battle_id, chain_id, author_wallet, body)
     values ($1, $2, $3, $4) returning id, author_wallet, body, created_at`,
    [battleId, chainId, verified.walletAddress, checked.text],
  );
  return json(res, 200, { ok: true, comment: commentFromRow({ ...rows[0], side: null }) });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const p = String(req.path || new URL(req.url, "http://localhost").pathname).replace(/\/+$/, "");
  const m = p.match(/^\/arena\/battles\/([^/]+)\/(activity|comments)$/);
  const battleId = m ? battleIdFrom(m[1]) : "";
  if (!m || !battleId) return json(res, 404, { error: `Unknown battle page route: ${p}` });
  try {
    if (m[2] === "activity" && method === "GET") return await handleActivity(res, battleId);
    if (m[2] === "comments" && method === "GET") return await handleCommentsGet(res, battleId);
    if (m[2] === "comments" && method === "POST") return await handleCommentCreate(req, res, battleId);
    return json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    if (isSchemaMissing(error)) return json(res, 503, { error: "Battle comments are not set up yet.", code: "BATTLE_COMMENTS_SCHEMA_MISSING" });
    console.error("[api/arena/battles activity]", error);
    return json(res, 503, { error: "Battle activity unavailable" });
  }
}
