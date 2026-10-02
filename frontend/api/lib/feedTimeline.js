/**
 * Unified feed timeline (founder, 2026-10-02): For you mixes everything (posts, reposts, creator coin
 * posts, launches, public drafts, graduations, battles) so people find coins and people they do not
 * follow yet; Following shows only what involves the wallets you follow. Infinite scroll by cursor
 * (`before` = the createdAt of the last item shown). System sources live here; post sources stay in
 * api/feed/posts.js next to the post SELECT.
 */
import { pool } from "../../server/db.js";
import { publicHiddenWhere } from "./publicHiddenCampaigns.js";

export const FEED_PAGE_SIZE = 30;

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Parse the `before` cursor; anything invalid means "from now". */
export function parseCursor(value) {
  const ts = Date.parse(String(value || ""));
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function missing(e) {
  return e?.code === "42P01" || e?.code === "42703";
}

/** Newest first; same timestamp keeps a stable order by id. Dedupes by id. */
export function mergeTimelinePage(sources, limit = FEED_PAGE_SIZE) {
  const seen = new Set();
  const all = [];
  for (const list of sources) {
    for (const item of list || []) {
      if (!item?.id || !item.createdAt || seen.has(item.id)) continue;
      seen.add(item.id);
      all.push(item);
    }
  }
  all.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || String(b.id).localeCompare(String(a.id)));
  const items = all.slice(0, limit);
  const nextCursor = items.length === limit ? items[items.length - 1].createdAt : null;
  return { items, nextCursor };
}

function authorFilter(column, authors, params) {
  if (!Array.isArray(authors)) return "";
  if (!authors.length) return " and false";
  const a = `$${params.push(authors)}`;
  const b = `$${params.push(authors.map((w) => String(w).toLowerCase()))}`;
  return ` and (${column} = any(${a}::text[]) or lower(${column}) = any(${b}::text[]))`;
}

function beforeFilter(column, before, params) {
  return before ? ` and ${column} < $${params.push(before)}` : "";
}

async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    if (missing(e)) return [];
    throw e;
  }
}

export function loadDeployEvents({ before, limit, authors }) {
  return safe(async () => {
    const params = [];
    const sql = `
      select c.chain_id, c.campaign_address, c.token_address, c.creator_address, c.name, c.symbol, c.logo_uri,
             coalesce(c.created_at_chain, c.created_at) as at
        from public.campaigns c
       where c.campaign_address is not null and not (${publicHiddenWhere("c")})
         ${beforeFilter("coalesce(c.created_at_chain, c.created_at)", before, params)}
         ${authorFilter("c.creator_address", authors, params)}
       order by at desc
       limit $${params.push(limit)}`;
    const { rows } = await pool.query(sql, params);
    return rows.map((r) => ({
      type: "coin_deployed",
      id: `deploy:${r.chain_id}:${r.campaign_address}`,
      createdAt: iso(r.at),
      wallet: r.creator_address,
      chainId: Number(r.chain_id) || null,
      campaignAddress: r.campaign_address,
      tokenAddress: r.token_address || null,
      name: r.name || null,
      ticker: r.symbol || null,
      logoUri: r.logo_uri || null,
    }));
  });
}

export function loadGraduationEvents({ before, limit, authors }) {
  return safe(async () => {
    const params = [];
    const sql = `
      select c.chain_id, c.campaign_address, c.token_address, c.creator_address, c.name, c.symbol, c.logo_uri,
             c.graduated_at_chain as at
        from public.campaigns c
       where c.graduated_at_chain is not null and c.campaign_address is not null and not (${publicHiddenWhere("c")})
         ${beforeFilter("c.graduated_at_chain", before, params)}
         ${authorFilter("c.creator_address", authors, params)}
       order by at desc
       limit $${params.push(limit)}`;
    const { rows } = await pool.query(sql, params);
    return rows.map((r) => ({
      type: "coin_graduated",
      id: `graduated:${r.chain_id}:${r.campaign_address}`,
      createdAt: iso(r.at),
      wallet: r.creator_address,
      chainId: Number(r.chain_id) || null,
      campaignAddress: r.campaign_address,
      tokenAddress: r.token_address || null,
      name: r.name || null,
      ticker: r.symbol || null,
      logoUri: r.logo_uri || null,
    }));
  });
}

export function loadDraftEvents({ before, limit, authors }) {
  return safe(async () => {
    const params = [];
    const sql = `
      select d.id, d.chain_id, d.creator_wallet, d.name, d.ticker, d.logo_url, d.slug, d.campaign_address, d.token_address, d.created_at as at
        from public.campaign_drafts d
       where d.visibility = 'public' and d.status <> 'archived'
         ${beforeFilter("d.created_at", before, params)}
         ${authorFilter("d.creator_wallet", authors, params)}
       order by at desc
       limit $${params.push(limit)}`;
    const { rows } = await pool.query(sql, params);
    return rows.map((r) => ({
      type: "draft_created",
      id: `draft:${r.id}`,
      createdAt: iso(r.at),
      wallet: r.creator_wallet,
      chainId: Number(r.chain_id) || null,
      campaignAddress: r.campaign_address || null,
      tokenAddress: r.token_address || null,
      name: r.name || null,
      ticker: r.ticker || null,
      logoUri: r.logo_url || null,
      slug: r.slug || null,
      draftId: r.id,
    }));
  });
}

function battleSides(participants) {
  const list = Array.isArray(participants) ? participants : [];
  return list.slice(0, 2).map((p) => ({
    symbol: p?.symbol || null,
    name: p?.tokenName || null,
    tokenAddress: p?.tokenAddress || p?.tokenId || null,
    ownerWallet: p?.ownerWallet || null,
    imageUrl: p?.imageUrl || p?.logoUri || null,
  }));
}

/** Battle went live (started_at) and battle result (finished_at with a winner). */
export function loadBattleEvents({ before, limit, authors }) {
  return safe(async () => {
    const owners = (p) =>
      Array.isArray(authors)
        ? ` and exists (select 1 from jsonb_array_elements(coalesce(b.participants, '[]'::jsonb)) x
                       where lower(coalesce(x->>'ownerWallet', '')) = any($${p.push(authors.map((w) => String(w).toLowerCase()))}::text[]))`
        : "";
    const p1 = [];
    const live = await pool.query(
      `select b.id, b.chain_id, b.battle_mode, b.participants, b.started_at as at, b.stake_native, b.native_symbol
         from public.arena_battles b
        where b.started_at is not null
          ${beforeFilter("b.started_at", before, p1)}
          ${owners(p1)}
        order by at desc
        limit $${p1.push(limit)}`,
      p1,
    );
    const p2 = [];
    const done = await pool.query(
      `select b.id, b.chain_id, b.battle_mode, b.participants, b.finished_at as at, b.winner_token
         from public.arena_battles b
        where b.finished_at is not null and b.winner_token is not null
          ${beforeFilter("b.finished_at", before, p2)}
          ${owners(p2)}
        order by at desc
        limit $${p2.push(limit)}`,
      p2,
    );
    return [
      ...live.rows.map((r) => ({
        type: "battle_started",
        id: `battle-live:${r.id}`,
        battleId: r.id,
        createdAt: iso(r.at),
        chainId: Number(r.chain_id) || null,
        battleMode: r.battle_mode || null,
        sides: battleSides(r.participants),
        stakeNative: r.stake_native == null ? null : Number(r.stake_native),
        nativeSymbol: r.native_symbol || null,
      })),
      ...done.rows.map((r) => ({
        type: "battle_finished",
        id: `battle-result:${r.id}`,
        battleId: r.id,
        createdAt: iso(r.at),
        chainId: Number(r.chain_id) || null,
        battleMode: r.battle_mode || null,
        sides: battleSides(r.participants),
        winnerToken: r.winner_token,
      })),
    ];
  });
}

/** Views per post for a page (separate query, so a database without the table reads as 0 views). */
export async function loadViewCounts(postIds) {
  const ids = [...new Set((postIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return new Map();
  try {
    const { rows } = await pool.query(
      `select post_id, count(*)::int as n from public.social_post_views where post_id = any($1::bigint[]) group by post_id`,
      [ids],
    );
    return new Map(rows.map((r) => [Number(r.post_id), Number(r.n)]));
  } catch (e) {
    if (missing(e)) return new Map();
    throw e;
  }
}

const VIEWER_KEY = /^(anon:[A-Za-z0-9-]{8,64}|0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

/** One view per viewer per post. viewer = wallet (EVM lowercased) or an anonymous browser id. */
export function canonViewerKey(value) {
  const raw = String(value || "").trim();
  const key = /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : raw;
  return VIEWER_KEY.test(key) ? key : "";
}

export async function recordViews(postIds, viewerKey) {
  const key = canonViewerKey(viewerKey);
  const ids = [...new Set((postIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))].slice(0, 40);
  if (!key || !ids.length) return 0;
  const { rowCount } = await pool.query(
    `insert into public.social_post_views (post_id, viewer_key)
     select p.id, $2 from public.social_posts p where p.id = any($1::bigint[]) and p.status = 0
     on conflict do nothing`,
    [ids, key],
  );
  return rowCount || 0;
}
