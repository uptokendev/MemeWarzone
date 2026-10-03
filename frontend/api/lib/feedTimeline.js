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

/**
 * Cursor = "<createdAt of the last chronological item>|<hot posts already served>". A bare timestamp
 * (older clients) still works. Anything invalid means "from now".
 */
export function parseCursor(value) {
  const [stamp, hot] = String(value || "").split("|");
  const ts = Date.parse(stamp);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

export function parseHotOffset(value) {
  const hot = Number(String(value || "").split("|")[1]);
  return Number.isFinite(hot) && hot > 0 ? Math.min(500, Math.trunc(hot)) : 0;
}

export function buildCursor(before, hotOffset) {
  return before ? `${before}|${Math.max(0, Math.trunc(hotOffset || 0))}` : null;
}

/**
 * Reach (founder, 2026-10-02: "popular posts get noticed quicker, including views"). Engagement per
 * hour with a gravity on age, so a post taking off now beats an old one with more total engagement.
 * Weights: repost 3, reply 2, rocket 1, view 0.05.
 */
export function hotScore({ createdAt, fireCount = 0, replyCount = 0, repostCount = 0, viewCount = 0 }, now = Date.now()) {
  const ts = Date.parse(String(createdAt || ""));
  const hours = Number.isFinite(ts) ? Math.max(0, (now - ts) / 3_600_000) : 48;
  const engagement = 3 * Number(repostCount || 0) + 2 * Number(replyCount || 0) + Number(fireCount || 0) + 0.05 * Number(viewCount || 0);
  return engagement / Math.pow(hours + 2, 1.5);
}

/**
 * Order one chronological page: posts from wallets you follow and well-engaged posts rise a little
 * within the page; system updates keep their time. Hot posts are mixed in at fixed slots.
 */
export function arrangeRankedPage(items, hot, { following = [], now = Date.now() } = {}) {
  const followed = new Set((following || []).map((w) => String(w || "").toLowerCase()));
  const pageScore = (item) => {
    const ts = Date.parse(String(item.createdAt || "")) || 0;
    const ageHours = Math.max(0, (now - ts) / 3_600_000);
    if (!item.postId) return -ageHours;
    const engagement = Math.log2(1 + Number(item.fireCount || 0) + 2 * Number(item.replyCount || 0) + 3 * Number(item.repostCount || 0) + 0.05 * Number(item.viewCount || 0));
    const follow = followed.has(String(item.wallet || "").toLowerCase()) ? 2 : 0;
    return -ageHours + engagement * 1.5 + follow;
  };
  const hotIds = new Set(hot.map((item) => item.id));
  const base = items.filter((item) => !hotIds.has(item.id)).sort((a, b) => pageScore(b) - pageScore(a));
  const out = [];
  let h = 0;
  for (let i = 0; i < base.length || h < hot.length; i += 1) {
    // Hot posts at slots 0, 4, 9, 14, ... so the page opens with what is taking off.
    if (h < hot.length && (out.length === 0 || out.length % 5 === 4)) out.push({ ...hot[h++], reach: "taking_off" });
    if (i < base.length) out.push(base[i]);
  }
  return out;
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

function logoKey(chainId, token) {
  const t = String(token || "").trim();
  return `${Number(chainId)}:${t.startsWith("0x") ? t.toLowerCase() : t}`;
}

// Battle participants are stored without a logo, so the feed card showed initials (founder, 2026-10-03).
// Same sources as the battle pages: launched coins' campaigns.logo_uri, imported coins' image_url.
async function loadBattleLogos(rows) {
  const chains = [];
  const tokens = [];
  for (const r of rows) {
    for (const side of battleSides(r.participants)) {
      if (side.imageUrl || !side.tokenAddress) continue;
      chains.push(Number(r.chain_id));
      tokens.push(String(side.tokenAddress));
    }
  }
  const map = new Map();
  if (!tokens.length) return map;
  const pairs = `select * from unnest($1::int[], $2::text[]) as q(chain_id, token)`;
  const lookups = [
    `select c.chain_id, c.token_address as token, c.logo_uri as logo
       from public.campaigns c join (${pairs}) q
         on q.chain_id = c.chain_id and (c.token_address = q.token or lower(c.token_address) = lower(q.token))
      where coalesce(c.logo_uri, '') <> ''`,
    `select i.chain_id, i.token_address as token, i.image_url as logo
       from public.arena_token_imports i join (${pairs}) q
         on q.chain_id = i.chain_id and (i.token_address = q.token or lower(i.token_address) = lower(q.token))
      where coalesce(i.image_url, '') <> ''`,
  ];
  for (const sql of lookups) {
    try {
      const { rows: found } = await pool.query(sql, [chains, tokens]);
      for (const f of found) {
        const key = logoKey(f.chain_id, f.token);
        if (!map.has(key)) map.set(key, String(f.logo));
      }
    } catch (e) {
      if (!missing(e)) throw e;
    }
  }
  return map;
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
    const logos = await loadBattleLogos([...live.rows, ...done.rows]);
    const sidesOf = (r) => battleSides(r.participants).map((side) => ({ ...side, imageUrl: side.imageUrl || logos.get(logoKey(r.chain_id, side.tokenAddress)) || null }));
    return [
      ...live.rows.map((r) => ({
        type: "battle_started",
        id: `battle-live:${r.id}`,
        battleId: r.id,
        createdAt: iso(r.at),
        chainId: Number(r.chain_id) || null,
        battleMode: r.battle_mode || null,
        sides: sidesOf(r),
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
        sides: sidesOf(r),
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

const VIEWER_KEY = /^(anon:[A-Za-z0-9-]{8,64}|ip:[0-9a-f]{32}|0x[0-9a-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

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
