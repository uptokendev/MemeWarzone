import crypto from "node:crypto";
import { attachHandles } from "../lib/userHandles.js";
import { notifyRepost, notifyRocket, notifySocialPost } from "../lib/socialNotify.js";
import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import { badMethod, getQuery, json, readJson } from "../../server/http.js";
import { verifySolanaSignature } from "../lib/walletActionAuth.js";
import {
  FEED_RANK_CANDIDATES,
  FIRE_RATE_LIMIT,
  POST_MAX_CHARS,
  POST_RATE_LIMIT,
  POST_RATE_WINDOW_MINUTES,
  REPLY_RATE_LIMIT,
  REPOST_RATE_LIMIT,
  buildPostCreateMessage,
  buildPostDeleteMessage,
  canonPostWallet,
} from "../lib/postsCanon.js";
import { AUTHOR_PROFILE_LATERAL, REPOSTER_PROFILE_LATERAL } from "../lib/feedProfileJoin.js";
import { rankFeedPosts } from "../lib/feedRanking.js";
import { createFeedSessionAuth } from "../lib/feedSessionAuth.js";
import { loadFollowingAddresses, loadPostEvents } from "../lib/socialTimeline.js";
import { hasCoinPostLink, notCoinPostSql } from "../lib/coinPostLink.js";
import { MAX_POST_IMAGES, cleanMediaUrls, hasMediaUrls, mediaUrlsSelect, refreshMediaUrlColumns, rowMediaUrls } from "../lib/postMediaUrls.js";
import { isSolanaAddress, isSolanaChain } from "../../server/http.js";
import { contractAddressInBody, isOwnFeedImage } from "../lib/feedPostMedia.js";
import {
  FEED_PAGE_SIZE,
  loadBattleEvents,
  loadDeployEvents,
  loadDraftEvents,
  loadGraduationEvents,
  loadViewCounts,
  arrangeRankedPage,
  buildCursor,
  hotScore,
  mergeTimelinePage,
  parseCursor,
  parseHotOffset,
  recordViews,
} from "../lib/feedTimeline.js";

const feedSession = createFeedSessionAuth({ pool });

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function missingTable(e) {
  return e?.code === "42P01" || e?.code === "42703";
}

function requestPath(req) {
  return String(req.path || req.url || "").split("?")[0];
}

function postIdFromReq(req, body = {}) {
  const fromParams = Number(req.params?.id);
  if (Number.isFinite(fromParams) && fromParams > 0) return fromParams;
  const fromBody = Number(body.postId ?? body.id);
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;
  const m = String(req.url || "").match(/\/posts\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

async function consumeNonce(chainId, address, nonce) {
  const { rows } = await pool.query(
    `SELECT nonce, expires_at, used_at
     FROM auth_nonces
     WHERE chain_id = $1 AND address = $2
     LIMIT 1`,
    [chainId, address],
  );
  const row = rows[0];
  if (!row) throw new Error("Nonce not found");
  if (row.used_at) throw new Error("Nonce already used");
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (!exp || Date.now() > exp) throw new Error("Nonce expired");
  if (String(row.nonce) !== String(nonce)) throw new Error("Nonce mismatch");

  await pool.query(
    `UPDATE auth_nonces
     SET used_at = NOW()
     WHERE chain_id = $1 AND address = $2`,
    [chainId, address],
  );
}

async function lookupMentionedCoin(campaign, token, ticker, chainHint) {
  try {
    const { rows } = await pool.query(
      `select chain_id, campaign_address, token_address
         from public.campaigns
        where (
            ($1::text <> '' and (campaign_address = $1 or token_address = $1
              or lower(campaign_address) = lower($1) or lower(token_address) = lower($1)))
            or ($2::text <> '' and (token_address = $2 or lower(token_address) = lower($2)))
            or ($3::text <> '' and upper(symbol) = upper($3))
          )
          and ($4::int is null or chain_id = $4)
        order by created_at_chain desc nulls last
        limit 1`,
      [campaign, token, ticker, Number.isFinite(chainHint) ? chainHint : null],
    );
    const row = rows[0];
    return row ? { chainId: Number(row.chain_id) || null, campaign: row.campaign_address || null, token: row.token_address || null } : null;
  } catch {
    return null;
  }
}

/** CO-18: a listed imported coin (status passed). Its card links to the imported coin page by token address. */
async function lookupMentionedImport(token, chainHint) {
  try {
    const { rows } = await pool.query(
      `select chain_id, token_address
         from public.arena_token_imports
        where status = 'passed'
          and (token_address = $1 or lower(token_address) = lower($1))
          and ($2::int is null or chain_id = $2)
        order by updated_at desc nulls last
        limit 1`,
      [token, Number.isFinite(chainHint) ? chainHint : null],
    );
    const row = rows[0];
    return row ? { chainId: Number(row.chain_id) || null, campaign: null, token: row.token_address || null } : null;
  } catch {
    return null;
  }
}

async function resolveMention(body, mentioned) {
  const chainHint = Number(mentioned?.chainId);
  const campaign = String(mentioned?.campaign || mentioned?.campaignAddress || "").trim();
  const token = String(mentioned?.token || mentioned?.tokenAddress || "").trim();
  const tickerMatch = String(body || "").match(/\$([A-Za-z0-9]{2,12})\b/);
  const ticker = tickerMatch ? tickerMatch[1] : "";
  // UI redesign phase 2: a contract address written in the post becomes its coin card.
  const bodyAddress = !campaign && !token ? contractAddressInBody(body) : "";
  if (bodyAddress) {
    const found = (await lookupMentionedCoin(bodyAddress, "", "", chainHint)) || (await lookupMentionedImport(bodyAddress, chainHint));
    if (found) return found;
  }

  if (!campaign && !token && !ticker) return { chainId: null, campaign: null, token: null };

  try {
    const { rows } = await pool.query(
      `select chain_id, campaign_address, token_address
         from public.campaigns
        where (
            ($1::text <> '' and (campaign_address = $1 or token_address = $1
              or lower(campaign_address) = lower($1) or lower(token_address) = lower($1)))
            or ($2::text <> '' and (token_address = $2 or lower(token_address) = lower($2)))
            or ($3::text <> '' and upper(symbol) = upper($3))
          )
          and ($4::int is null or chain_id = $4)
        order by created_at_chain desc nulls last
        limit 1`,
      [campaign, token, ticker, Number.isFinite(chainHint) ? chainHint : null],
    );
    const row = rows[0];
    if (!row) {
      return {
        chainId: Number.isFinite(chainHint) ? chainHint : null,
        campaign: campaign || null,
        token: token || null,
      };
    }
    return {
      chainId: Number(row.chain_id) || null,
      campaign: row.campaign_address || null,
      token: row.token_address || null,
    };
  } catch {
    return {
      chainId: Number.isFinite(chainHint) ? chainHint : null,
      campaign: campaign || null,
      token: token || null,
    };
  }
}

function mapPostRow(row, extras = {}) {
  return {
    type: "post",
    id: extras.id || `post:${row.id}`,
    postId: Number(row.id),
    createdAt: row.sort_at
      ? new Date(row.sort_at).toISOString()
      : row.created_at
        ? new Date(row.created_at).toISOString()
        : null,
    wallet: row.author_address,
    body: row.body,
    mediaUrl: row.media_url || null,
    mediaUrls: rowMediaUrls(row),
    mentionedChainId: row.mentioned_chain_id == null ? null : Number(row.mentioned_chain_id),
    mentionedCampaign: row.mentioned_campaign || null,
    mentionedToken: row.mentioned_token || null,
    authorDisplayName: row.author_display_name || null,
    authorAvatarUrl: row.author_avatar_url || null,
    tokenName: row.token_name || null,
    tokenTicker: row.token_ticker || null,
    tokenLogoUri: row.token_logo_uri || null,
    parentId: row.parent_id == null ? null : Number(row.parent_id),
    fireCount: Number(row.fire_count || 0),
    replyCount: Number(row.reply_count || 0),
    repostCount: Number(row.repost_count || 0),
    firedByMe: Boolean(row.fired_by_me),
    repostedByMe: Boolean(row.reposted_by_me),
    repostedByWallet: extras.repostedByWallet || row.reposted_by || null,
    repostedByDisplayName: extras.repostedByDisplayName || row.reposted_by_display_name || null,
    quoteOfId: row.quote_of_id == null ? null : Number(row.quote_of_id),
    quoted: row.quote_of_id != null && row.quoted_body != null
      ? {
          postId: Number(row.quote_of_id),
          wallet: row.quoted_author || null,
          body: row.quoted_body,
          mediaUrl: row.quoted_media_url || null,
          createdAt: row.quoted_created_at ? new Date(row.quoted_created_at).toISOString() : null,
          authorDisplayName: row.quoted_display_name || null,
          authorAvatarUrl: row.quoted_avatar_url || null,
        }
      : null,
  };
}

const POST_FROM = `
       from public.social_posts p
       ${AUTHOR_PROFILE_LATERAL}
       left join lateral (
         select q.author_address, q.body, q.media_url, q.created_at, qup.display_name, qup.avatar_url
           from public.social_posts q
           left join lateral (
             select u.display_name, u.avatar_url from public.user_profiles u
              where lower(u.address) = lower(q.author_address)
              order by
                (u.display_name is not null and length(btrim(u.display_name)) > 0) desc,
                (u.avatar_url is not null and length(btrim(u.avatar_url)) > 0) desc,
                u.updated_at desc nulls last
              limit 1
           ) qup on true
          where q.id = p.quote_of_id and q.status = 0
          limit 1
       ) qp on true
       left join public.campaigns c
         on p.mentioned_chain_id is not null
        and c.chain_id = p.mentioned_chain_id
        and (
          c.campaign_address = p.mentioned_campaign
          or c.token_address = p.mentioned_token
          or lower(c.campaign_address) = lower(coalesce(p.mentioned_campaign, ''))
          or lower(c.token_address) = lower(coalesce(p.mentioned_token, ''))
        )
       -- CO-18: a listed imported coin (no campaign row) still gets its coin card.
       left join lateral (
         select ai.name, ai.symbol, ai.image_url
           from public.arena_token_imports ai
          where c.campaign_address is null
            and p.mentioned_chain_id is not null
            and p.mentioned_token is not null
            and ai.chain_id = p.mentioned_chain_id
            and ai.status = 'passed'
            and (ai.token_address = p.mentioned_token or lower(ai.token_address) = lower(p.mentioned_token))
          limit 1
       ) ai on true
`;

function postSelect(viewerPlaceholder) {
  const viewer = viewerPlaceholder || "null";
  return `
select
  p.id,
  p.author_address,
  p.body,
  p.media_url,
  ${mediaUrlsSelect("p")},
  p.mentioned_chain_id,
  p.mentioned_campaign,
  p.mentioned_token,
  p.created_at,
  p.parent_id,
  p.quote_of_id,
  qp.author_address as quoted_author,
  qp.body as quoted_body,
  qp.media_url as quoted_media_url,
  qp.created_at as quoted_created_at,
  qp.display_name as quoted_display_name,
  qp.avatar_url as quoted_avatar_url,
  up.display_name as author_display_name,
  up.avatar_url as author_avatar_url,
  coalesce(c.name, ai.name) as token_name,
  coalesce(c.symbol, ai.symbol) as token_ticker,
  coalesce(c.logo_uri, ai.image_url) as token_logo_uri,
  coalesce((select count(*)::int from public.social_post_fires f where f.post_id = p.id), 0) as fire_count,
  coalesce((select count(*)::int from public.social_posts r where r.parent_id = p.id and r.status = 0), 0) as reply_count,
  coalesce((select count(*)::int from public.social_post_reposts rp where rp.post_id = p.id), 0) as repost_count,
  exists(
    select 1 from public.social_post_fires f
     where f.post_id = p.id
       and ${viewer}::text is not null
       and (f.author_address = ${viewer} or lower(f.author_address) = lower(${viewer}))
  ) as fired_by_me,
  exists(
    select 1 from public.social_post_reposts rp
     where rp.post_id = p.id
       and ${viewer}::text is not null
       and (rp.author_address = ${viewer} or lower(rp.author_address) = lower(${viewer}))
  ) as reposted_by_me
`;
}

async function queryPosts({ limit, authors, viewer, parentId, ranked }) {
  const params = [];
  const viewerSql = viewer ? `$${params.push(viewer)}` : "null";
  let sql = `${postSelect(viewerSql)} ${POST_FROM} where p.status = 0`;
  if (parentId) {
    sql += ` and p.parent_id = $${params.push(parentId)}`;
  } else {
    sql += ` and p.parent_id is null${await notCoinPostSql()}`;
  }
  if (Array.isArray(authors) && authors.length) {
    sql += ` and (p.author_address = any($${params.push(authors)}::text[]) or lower(p.author_address) = any($${params.push(authors.map((w) => w.toLowerCase()))}::text[]))`;
  }
  sql += " order by p.created_at desc, p.id desc";
  sql += ` limit $${params.push(limit)}`;
  const { rows } = await pool.query(sql, params);
  const items = rows.map((row) => mapPostRow(row));
  if (ranked) return rankFeedPosts(items, { following: ranked.following || [], limit: ranked.limit || items.length });
  return items;
}

async function queryFollowing(viewer, following, limit) {
  const params = [viewer, following, following.map((w) => w.toLowerCase()), limit];
  const shadow = await notCoinPostSql();
  const sql = `
with own_posts as (
  ${postSelect("$1")}
  ${POST_FROM}
  where p.status = 0
    and p.parent_id is null${shadow}
    and (p.author_address = any($2::text[]) or lower(p.author_address) = any($3::text[]))
),
reposted as (
  ${postSelect("$1")}
    , rp.author_address as reposted_by
    , rup.display_name as reposted_by_display_name
    , rp.created_at as sort_at
  ${POST_FROM}
  join public.social_post_reposts rp on rp.post_id = p.id
  ${REPOSTER_PROFILE_LATERAL}
  where p.status = 0
    and (rp.author_address = any($2::text[]) or lower(rp.author_address) = any($3::text[]))
)
select * from (
  select id, author_address, body, media_url, media_urls, mentioned_chain_id, mentioned_campaign, mentioned_token,
         created_at, parent_id, quote_of_id, quoted_author, quoted_body, quoted_media_url, quoted_created_at,
         quoted_display_name, quoted_avatar_url, author_display_name, author_avatar_url, token_name, token_ticker, token_logo_uri,
         fire_count, reply_count, repost_count, fired_by_me, reposted_by_me,
         null::text as reposted_by, null::text as reposted_by_display_name, created_at as sort_at
    from own_posts
  union all
  select id, author_address, body, media_url, media_urls, mentioned_chain_id, mentioned_campaign, mentioned_token,
         created_at, parent_id, quote_of_id, quoted_author, quoted_body, quoted_media_url, quoted_created_at,
         quoted_display_name, quoted_avatar_url, author_display_name, author_avatar_url, token_name, token_ticker, token_logo_uri,
         fire_count, reply_count, repost_count, fired_by_me, reposted_by_me,
         reposted_by, reposted_by_display_name, sort_at
    from reposted
) feed
order by sort_at desc, id desc
limit $4
`;
  const { rows } = await pool.query(sql, params);
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const key = String(row.id);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(mapPostRow(row, {
      id: row.reposted_by ? `repost:${row.reposted_by}:${row.id}` : `post:${row.id}`,
      repostedByWallet: row.reposted_by || null,
      repostedByDisplayName: row.reposted_by_display_name || null,
    }));
  }
  return items;
}

async function loadRecentPosts({ limit, author, authors, viewer, ranked }) {
  if (author) return loadPostEvents([author], { limit, viewer });
  try {
    return await queryPosts({
      limit: ranked ? Math.max(limit, FEED_RANK_CANDIDATES) : limit,
      authors,
      viewer,
      ranked: ranked ? { following: ranked.following || [], limit } : null,
    });
  } catch (e) {
    if (missingTable(e)) {
      if (author) return loadPostEvents([author], { limit });
      if (Array.isArray(authors) && authors.length) return loadPostEvents(authors, { limit });
      return loadPostEvents([], { limit, all: true });
    }
    throw e;
  }
}

// Creator updates take reactions through their linked social_posts row (founder, 2026-10-03): the card
// gets that row's id (postId) and its counts, so the action row works like on any post.
async function attachCoinPostEngagement(items, viewer) {
  if (!items.length || !(await hasCoinPostLink())) return items;
  const params = [];
  const viewerSql = viewer ? `$${params.push(viewer)}` : "null";
  const ids = items.map((item) => item.coinPostId);
  const { rows } = await pool.query(
    `${postSelect(viewerSql)}, p.coin_post_id ${POST_FROM} where p.status = 0 and p.coin_post_id = any($${params.push(ids)}::bigint[])`,
    params,
  );
  const byCoinPost = new Map(rows.map((row) => [Number(row.coin_post_id), row]));
  return items.map((item) => {
    const row = byCoinPost.get(item.coinPostId);
    if (!row) return item;
    return {
      ...item,
      postId: Number(row.id),
      fireCount: Number(row.fire_count || 0),
      replyCount: Number(row.reply_count || 0),
      repostCount: Number(row.repost_count || 0),
      firedByMe: Boolean(row.fired_by_me),
      repostedByMe: Boolean(row.reposted_by_me),
    };
  });
}

async function loadSharedCoinPosts(limit, { before = null, authors = null, viewer = null } = {}) {
  try {
    const params = [limit];
    const extra = [
      before ? `and cp.created_at < $${params.push(before)}` : "",
      Array.isArray(authors)
        ? `and lower(cp.author_wallet) = any($${params.push(authors.map((w) => String(w).toLowerCase()))}::text[])`
        : "",
    ].join(" ");
    const { rows } = await pool.query(
      `select cp.id, cp.chain_id, cp.token_address, cp.author_wallet, cp.body, cp.media_url, ${mediaUrlsSelect("cp", "coin")}, cp.created_at,
              c.campaign_address, c.name as token_name, c.symbol as token_ticker, c.logo_uri as token_logo_uri
         from public.coin_posts cp
         left join lateral (
           select campaign_address, name, symbol, logo_uri from public.campaigns c
            where c.chain_id = cp.chain_id
              and (c.token_address = cp.token_address or lower(c.token_address) = lower(cp.token_address))
            limit 1
         ) c on true
        where cp.status = 0 and cp.share_to_feed = true ${extra}
        order by cp.created_at desc, cp.id desc
        limit $1`,
      params,
    );
    const items = rows.map((row) => ({
      type: "coin_post",
      id: `coin_post:${row.id}`,
      coinPostId: Number(row.id),
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      wallet: row.author_wallet,
      body: row.body,
      mediaUrl: row.media_url || null,
      mediaUrls: rowMediaUrls(row),
      chainId: Number(row.chain_id),
      tokenAddress: row.token_address,
      campaignAddress: row.campaign_address || null,
      tokenName: row.token_name || null,
      tokenTicker: row.token_ticker || null,
      tokenLogoUri: row.token_logo_uri || null,
      fireCount: 0,
      replyCount: 0,
      repostCount: 0,
    }));
    return await attachCoinPostEngagement(items, viewer);
  } catch (e) {
    if (missingTable(e)) return [];
    throw e;
  }
}

/** Top-level posts older than `before`, optionally only from `authors`. */
async function queryPostsPage({ before, limit, authors, viewer }) {
  const params = [];
  const viewerSql = viewer ? `$${params.push(viewer)}` : "null";
  let sql = `${postSelect(viewerSql)} ${POST_FROM} where p.status = 0 and p.parent_id is null${await notCoinPostSql()}`;
  if (before) sql += ` and p.created_at < $${params.push(before)}`;
  if (Array.isArray(authors)) {
    sql += ` and lower(p.author_address) = any($${params.push(authors.map((w) => String(w).toLowerCase()))}::text[])`;
  }
  sql += ` order by p.created_at desc, p.id desc limit $${params.push(limit)}`;
  const { rows } = await pool.query(sql, params);
  return rows.map((row) => mapPostRow(row));
}

/** Reposts (at the moment of reposting) older than `before`, optionally only by `reposters`. */
async function queryRepostsPage({ before, limit, reposters, viewer }) {
  const params = [];
  const viewerSql = viewer ? `$${params.push(viewer)}` : "null";
  let sql = `${postSelect(viewerSql)}
    , rp.author_address as reposted_by
    , rup.display_name as reposted_by_display_name
    , rp.created_at as sort_at
    ${POST_FROM}
    join public.social_post_reposts rp on rp.post_id = p.id
    ${REPOSTER_PROFILE_LATERAL}
    where p.status = 0`;
  if (before) sql += ` and rp.created_at < $${params.push(before)}`;
  if (Array.isArray(reposters)) {
    sql += ` and lower(rp.author_address) = any($${params.push(reposters.map((w) => String(w).toLowerCase()))}::text[])`;
  }
  sql += ` order by rp.created_at desc limit $${params.push(limit)}`;
  const { rows } = await pool.query(sql, params);
  return rows.map((row) =>
    mapPostRow(row, {
      id: `repost:${row.reposted_by}:${row.id}`,
      repostedByWallet: row.reposted_by || null,
      repostedByDisplayName: row.reposted_by_display_name || null,
    }),
  );
}

/**
 * For you (authors = null): everything. Following (authors = followed wallets): only their posts,
 * reposts, coin posts, launches, drafts, graduations and battles. One page, newest first.
 */
/** Posts taking off: last 48 h, ranked by engagement per hour (views included), skipping `offset`. */
async function loadHotPosts({ limit, offset, authors, viewer }) {
  const params = [];
  const viewerSql = viewer ? `$${params.push(viewer)}` : "null";
  let sql = `${postSelect(viewerSql)} ${POST_FROM} where p.status = 0 and p.parent_id is null and p.created_at > now() - interval '48 hours'${await notCoinPostSql()}`;
  if (Array.isArray(authors)) {
    sql += ` and lower(p.author_address) = any($${params.push(authors.map((w) => String(w).toLowerCase()))}::text[])`;
  }
  sql += ` order by p.created_at desc limit 300`;
  const { rows } = await pool.query(sql, params);
  const items = rows.map((row) => mapPostRow(row));
  const views = await loadViewCounts(items.map((item) => item.postId));
  return items
    .map((item) => ({ ...item, viewCount: views.get(Number(item.postId)) || 0 }))
    .filter((item) => Number(item.fireCount) + Number(item.replyCount) + Number(item.repostCount) + Number(item.viewCount) > 0)
    .map((item) => ({ item, score: hotScore(item) }))
    .sort((a, b) => b.score - a.score)
    .slice(offset, offset + limit)
    .map((row) => row.item);
}

async function loadTimelinePage({ before, limit, authors, viewer, ownPostsOnly = false }) {
  const take = limit + 5;
  const guard = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (missingTable(e)) return [];
      throw e;
    }
  };
  const sources = await Promise.all([
    guard(() => queryPostsPage({ before, limit: take, authors, viewer })),
    guard(() => queryRepostsPage({ before, limit: take, reposters: authors, viewer })),
    loadSharedCoinPosts(take, { before, authors, viewer }),
    // A public profile is the person's own posts (founder, 2026-10-04): launches, drafts, graduations
    // and battles stay in the feed, not on the profile.
    ownPostsOnly ? [] : loadDeployEvents({ before, limit: take, authors }),
    ownPostsOnly ? [] : loadDraftEvents({ before, limit: take, authors }),
    ownPostsOnly ? [] : loadGraduationEvents({ before, limit: take, authors }),
    ownPostsOnly ? [] : loadBattleEvents({ before, limit: take, authors }),
  ]);
  const page = mergeTimelinePage(sources, limit);
  const views = await loadViewCounts(page.items.map((item) => item.postId).filter(Boolean));
  page.items = page.items.map((item) => (item.postId ? { ...item, viewCount: views.get(Number(item.postId)) || 0 } : item));
  return page;
}

/** Chronological page + reach: hot posts mixed in, followed / engaged posts nudged up within the page. */
async function loadRankedPage({ cursor, limit, authors, viewer, following }) {
  const before = parseCursor(cursor);
  const hotOffset = parseHotOffset(cursor);
  const hotCount = Math.max(1, Math.ceil(limit / 6));
  const [page, hotRaw] = await Promise.all([
    loadTimelinePage({ before, limit, authors, viewer }),
    loadHotPosts({ limit: hotCount, offset: hotOffset, authors, viewer }).catch((e) => {
      if (missingTable(e)) return [];
      throw e;
    }),
  ]);
  const inPage = new Set(page.items.map((item) => item.id));
  const hot = hotRaw.filter((item) => !inPage.has(item.id));
  return {
    items: arrangeRankedPage(page.items, hot, { following }),
    nextCursor: buildCursor(page.nextCursor, hotOffset + hotRaw.length),
  };
}

async function handleGet(req, res) {
  const q = getQuery(req);
  const limit = clampInt(q.limit, 1, 100, 40);
  const tab = String(q.tab || "").toLowerCase();
  const author = canonPostWallet(q.chainId || (isSolanaAddress(q.author) ? 101 : 0), q.author || "");
  const viewer = String(q.viewer || q.wallet || "").trim();

  if (author && !tab) {
    const items = await loadRecentPosts({ limit, author, viewer });
    return json(res, 200, { items: await attachHandles(items), tab: "author", author });
  }

  const pageSize = clampInt(q.limit, 1, 60, FEED_PAGE_SIZE);
  // Public profile Posts tab (UI redesign phase 8): one wallet's posts, reposts and creator updates,
  // newest first, infinite scroll. No auto updates (founder, 2026-10-04): those belong in the feed.
  if (tab === "profile") {
    if (!author) return json(res, 400, { error: "author is required", code: "FEED_PROFILE_AUTHOR" });
    const page = await loadTimelinePage({ before: parseCursor(q.before), limit: pageSize, authors: [author], viewer, ownPostsOnly: true });
    return json(res, 200, { ...page, items: await attachHandles(page.items), tab: "profile", author });
  }
  if (tab === "following") {
    if (!viewer) return json(res, 200, { items: [], nextCursor: null, tab: "following", warning: "Connect a wallet to load Following." });
    // Following = only the wallets you follow (founder, 2026-10-02). Your own posts and reposts are in For you.
    const following = await loadFollowingAddresses(viewer);
    if (!following.length) return json(res, 200, { items: [], nextCursor: null, tab: "following" });
    const page = await loadRankedPage({ cursor: q.before, limit: pageSize, authors: following, viewer, following });
    return json(res, 200, { ...page, items: await attachHandles(page.items), tab: "following" });
  }

  // For you = everything, newest first, infinite scroll (founder, 2026-10-02).
  const following = viewer ? await loadFollowingAddresses(viewer) : [];
  const page = await loadRankedPage({ cursor: q.before, limit: pageSize, authors: null, viewer, following });
  return json(res, 200, { ...page, items: await attachHandles(page.items), tab: "for-you" });
}

// Unique views (founder, 2026-10-03): the server decides who the viewer is. A verified wallet (feed
// session) counts once per post; everyone else counts once per post per IP address, stored only as a
// salted hash. The browser's own viewer id is ignored: it could be regenerated or set to any wallet.
function clientIp(req) {
  const real = String(req.headers?.["x-real-ip"] || "").trim();
  if (real) return real;
  const forwarded = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "";
}

function ipViewerKey(req) {
  const ip = clientIp(req);
  if (!ip) return "";
  const salt = String(process.env.VIEW_HASH_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.DATABASE_URL || "mwz-views");
  return `ip:${crypto.createHash("sha256").update(`${salt}|${ip}`).digest("hex").slice(0, 32)}`;
}

async function handleViews(req, res) {
  const b = req.body && typeof req.body === "object" && Object.keys(req.body).length ? req.body : await readJson(req);
  try {
    // A bad or expired session token falls back to the IP key quietly (no 401 for a view).
    const quiet = { status() { return this; }, json() { return this; } };
    const session = hasSessionToken(req) ? await feedSession.requireSession(req, quiet) : null;
    const viewerKey = session ? session.walletAddress : ipViewerKey(req);
    const added = await recordViews(Array.isArray(b.postIds) ? b.postIds : [], viewerKey);
    return json(res, 200, { ok: true, added });
  } catch (e) {
    if (missingTable(e)) return json(res, 200, { ok: true, added: 0, warning: "views not set up yet" });
    throw e;
  }
}

async function handleGetOne(req, res) {
  const postId = postIdFromReq(req);
  if (!Number.isFinite(postId) || postId <= 0) return json(res, 400, { error: "Invalid post id" });
  const q = getQuery(req);
  const viewer = String(q.viewer || q.wallet || "").trim();
  const params = [];
  const viewerSql = viewer ? `$${params.push(viewer)}` : "null";
  const sql = `${postSelect(viewerSql)} ${POST_FROM} where p.status = 0 and p.id = $${params.push(postId)} limit 1`;
  try {
    const { rows } = await pool.query(sql, params);
    if (!rows[0]) return json(res, 404, { error: "Post not found" });
    const views = await loadViewCounts([postId]);
    const [item] = await attachHandles([{ ...mapPostRow(rows[0]), viewCount: views.get(postId) || 0 }]);
    return json(res, 200, { item });
  } catch (e) {
    if (missingTable(e)) return json(res, 404, { error: "Post not found" });
    throw e;
  }
}

async function handleGetReplies(req, res) {
  const postId = postIdFromReq(req);
  if (!Number.isFinite(postId) || postId <= 0) return json(res, 400, { error: "Invalid post id" });
  const q = getQuery(req);
  const viewer = String(q.viewer || q.wallet || "").trim();
  const limit = clampInt(q.limit, 1, 100, 50);
  try {
    const items = await queryPosts({ limit, viewer, parentId: postId });
    items.sort((a, b) => Date.parse(String(a.createdAt || "")) - Date.parse(String(b.createdAt || "")));
    return json(res, 200, { items: await attachHandles(items), postId });
  } catch (e) {
    if (missingTable(e)) return json(res, 200, { items: [], postId });
    throw e;
  }
}

function hasSessionToken(req) {
  return /^Bearer\s+\S+/i.test(String(req.headers?.authorization || "")) || Boolean(String(req.headers?.["x-feed-session"] || "").trim());
}

async function handleCreate(req, res) {
  const b = req.body && typeof req.body === "object" && Object.keys(req.body).length ? req.body : await readJson(req);
  // UI redesign (founder, 2026-10-02): a connected wallet signs once per 30-day session instead of every
  // post. With a session the wallet comes from the session; without one the signed path below is unchanged.
  const session = hasSessionToken(req) ? await feedSession.requireSession(req, res) : null;
  if (hasSessionToken(req) && !session) return;
  const chainId = session ? Number(session.chainId) : Number(b.chainId);
  const address = session ? canonPostWallet(chainId, session.walletAddress) : canonPostWallet(chainId, b.address);
  const body = String(b.body ?? "");
  const nonce = String(b.nonce ?? "");
  const signature = String(b.signature ?? "");
  // Up to 4 images (founder, 2026-10-04), on the session path. The first one is also media_url, so the
  // signed path and every single-image reader stay as they were.
  const extraImages = session ? cleanMediaUrls(b.mediaUrls) : [];
  const mediaUrl = String(b.mediaUrl ?? "").trim() || extraImages[0] || null;
  const mediaUrls = extraImages.length ? (extraImages[0] === mediaUrl ? extraImages : [mediaUrl, ...extraImages.filter((u) => u !== mediaUrl)].filter(Boolean)) : [];
  const quoteOf = Number(b.quoteOf ?? 0) > 0 ? Math.trunc(Number(b.quoteOf)) : null;

  if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
  if (!address) return json(res, 400, { error: "Invalid address" });
  if (mediaUrls.length > MAX_POST_IMAGES) return json(res, 400, { error: `At most ${MAX_POST_IMAGES} images per post`, code: "FEED_IMAGE_COUNT" });
  for (const url of mediaUrl ? [mediaUrl, ...mediaUrls] : mediaUrls) {
    if (!isOwnFeedImage(url, { storageBase: process.env.SUPABASE_URL, wallet: address })) {
      return json(res, 400, { error: "Image must be uploaded through the post composer", code: "FEED_IMAGE_INVALID" });
    }
  }
  const trimmed = body.trim();
  if (!trimmed) return json(res, 400, { error: "Post is empty" });
  if (trimmed.length > POST_MAX_CHARS) return json(res, 400, { error: `Post too long (max ${POST_MAX_CHARS})` });
  if (!session) {
    if (!nonce) return json(res, 400, { error: "Nonce missing" });
    if (!signature) return json(res, 400, { error: "Signature missing" });

    await consumeNonce(chainId, address, nonce);

    const msg = buildPostCreateMessage({ chainId, address, nonce, body: trimmed, mediaUrl, quoteOf });
    const solana = isSolanaChain(chainId) || isSolanaAddress(address);
    if (solana) {
      if (!verifySolanaSignature(msg, signature, address)) return json(res, 401, { error: "Invalid signature" });
    } else {
      const recovered = ethers.verifyMessage(msg, signature).toLowerCase();
      if (recovered !== address) return json(res, 401, { error: "Invalid signature" });
    }
  }

  if (quoteOf) {
    const quoted = await requireLivePost(quoteOf);
    // Replies can be quoted like posts (founder, 2026-10-03).
    if (!quoted) return json(res, 404, { error: "The post you are quoting is gone", code: "FEED_QUOTE_MISSING" });
  }

  let recent;
  try {
    recent = await pool.query(
      `select count(*)::int as n
         from public.social_posts
        where (author_address = $1 or lower(author_address) = lower($1))
          and parent_id is null
          and created_at > now() - ($2::int * interval '1 minute')`,
      [address, POST_RATE_WINDOW_MINUTES],
    );
  } catch (e) {
    if (!missingTable(e)) throw e;
    recent = await pool.query(
      `select count(*)::int as n
         from public.social_posts
        where (author_address = $1 or lower(author_address) = lower($1))
          and created_at > now() - ($2::int * interval '1 minute')`,
      [address, POST_RATE_WINDOW_MINUTES],
    );
  }
  if (Number(recent.rows[0]?.n || 0) >= POST_RATE_LIMIT) {
    return json(res, 429, { error: "Too many posts. Wait a few minutes." });
  }

  const mention = await resolveMention(trimmed, b.mentioned || b);
  let rows;
  try {
    ({ rows } = quoteOf
      ? await pool.query(
          `insert into public.social_posts (
             author_address, body, media_url, mentioned_chain_id, mentioned_campaign, mentioned_token, status, parent_id, quote_of_id
           ) values ($1, $2, $3, $4, $5, $6, 0, null, $7)
           returning id, created_at`,
          [address, trimmed, mediaUrl, mention.chainId, mention.campaign, mention.token, quoteOf],
        )
      : await pool.query(
          `insert into public.social_posts (
             author_address, body, media_url, mentioned_chain_id, mentioned_campaign, mentioned_token, status, parent_id
           ) values ($1, $2, $3, $4, $5, $6, 0, null)
           returning id, created_at`,
          [address, trimmed, mediaUrl, mention.chainId, mention.campaign, mention.token],
        ));
  } catch (e) {
    if (!missingTable(e)) throw e;
    if (quoteOf) return json(res, 503, { error: "Quote posts are not set up yet.", code: "FEED_QUOTE_SCHEMA_MISSING" });
    ({ rows } = await pool.query(
      `insert into public.social_posts (
         author_address, body, media_url, mentioned_chain_id, mentioned_campaign, mentioned_token, status
       ) values ($1, $2, $3, $4, $5, $6, 0)
       returning id, created_at`,
      [address, trimmed, mediaUrl, mention.chainId, mention.campaign, mention.token],
    ));
  }

  // CO-5: quoted author and @mentions (fire-and-forget; never delays or fails the post).
  // The full image list, written right after the insert so the insert paths above stay unchanged.
  if (rows[0]?.id && mediaUrls.length > 1 && hasMediaUrls("social")) {
    await pool.query(`update public.social_posts set media_urls = $2::text[] where id = $1`, [rows[0].id, mediaUrls]);
  }
  if (rows[0]?.id) void notifySocialPost(pool, { postId: rows[0].id, actor: address, body: trimmed, quoteOfId: quoteOf || null });
  return json(res, 200, {
    id: rows[0]?.id ?? null,
    createdAt: rows[0]?.created_at ? new Date(rows[0].created_at).toISOString() : null,
  });
}

async function handleDelete(req, res) {
  const b = await readJson(req);
  // Delete from the "…" menu (founder, 2026-10-03) runs on the feed session (one signature per 30 days):
  // the wallet comes from the session, so only the session's own posts match below. Without a session
  // the signed path is unchanged.
  const session = hasSessionToken(req) ? await feedSession.requireSession(req, res) : null;
  if (hasSessionToken(req) && !session) return;
  const chainId = session ? Number(session.chainId) : Number(b.chainId);
  const address = session ? canonPostWallet(chainId, session.walletAddress) : canonPostWallet(chainId, b.address);
  const nonce = String(b.nonce ?? "");
  const signature = String(b.signature ?? "");
  const postId = postIdFromReq(req, b);

  if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
  if (!address) return json(res, 400, { error: "Invalid address" });
  if (!Number.isFinite(postId) || postId <= 0) return json(res, 400, { error: "Invalid post id" });
  if (!session) {
    if (!nonce) return json(res, 400, { error: "Nonce missing" });
    if (!signature) return json(res, 400, { error: "Signature missing" });

    await consumeNonce(chainId, address, nonce);
    const msg = buildPostDeleteMessage({ chainId, address, nonce, postId });
    const solana = isSolanaChain(chainId) || isSolanaAddress(address);
    if (solana) {
      if (!verifySolanaSignature(msg, signature, address)) return json(res, 401, { error: "Invalid signature" });
    } else {
      const recovered = ethers.verifyMessage(msg, signature).toLowerCase();
      if (recovered !== address) return json(res, 401, { error: "Invalid signature" });
    }
  }

  const { rowCount } = await pool.query(
    `update public.social_posts
        set status = 2
      where id = $1
        and (author_address = $2 or lower(author_address) = lower($2))
        and status = 0`,
    [postId, address],
  );
  if (!rowCount) return json(res, 404, { error: "Post not found" });
  return json(res, 200, { ok: true, id: postId });
}

async function requireLivePost(postId) {
  const { rows } = await pool.query(
    `select id, status, parent_id from public.social_posts where id = $1`,
    [postId],
  );
  const row = rows[0];
  if (!row || Number(row.status) !== 0) return null;
  return row;
}

async function countRecent(table, address) {
  const { rows } = await pool.query(
    `select count(*)::int as n
       from ${table}
      where (author_address = $1 or lower(author_address) = lower($1))
        and created_at > now() - ($2::int * interval '1 minute')`,
    [address, POST_RATE_WINDOW_MINUTES],
  );
  return Number(rows[0]?.n || 0);
}

async function handleFire(req, res) {
  const session = await feedSession.requireSession(req, res);
  if (!session) return;
  const postId = postIdFromReq(req);
  if (!Number.isFinite(postId) || postId <= 0) return json(res, 400, { error: "Invalid post id" });
  const live = await requireLivePost(postId);
  if (!live) return json(res, 404, { error: "Post not found" });

  const address = session.walletAddress;
  const existing = await pool.query(
    `select 1 from public.social_post_fires
      where post_id = $1 and (author_address = $2 or lower(author_address) = lower($2))
      limit 1`,
    [postId, address],
  );
  if (existing.rows.length) {
    await pool.query(
      `delete from public.social_post_fires
        where post_id = $1 and (author_address = $2 or lower(author_address) = lower($2))`,
      [postId, address],
    );
    const { rows } = await pool.query(`select count(*)::int as n from public.social_post_fires where post_id = $1`, [postId]);
    return json(res, 200, { ok: true, on: false, fireCount: Number(rows[0]?.n || 0) });
  }

  if ((await countRecent("public.social_post_fires", address)) >= FIRE_RATE_LIMIT) {
    return json(res, 429, { error: "Too many fires. Wait a few minutes." });
  }
  await pool.query(
    `insert into public.social_post_fires (post_id, author_address) values ($1, $2)
     on conflict do nothing`,
    [postId, address],
  );
  void notifyRocket(pool, { postId, actor: address });
  const { rows } = await pool.query(`select count(*)::int as n from public.social_post_fires where post_id = $1`, [postId]);
  return json(res, 200, { ok: true, on: true, fireCount: Number(rows[0]?.n || 0) });
}

async function handleRepost(req, res) {
  const session = await feedSession.requireSession(req, res);
  if (!session) return;
  const postId = postIdFromReq(req);
  if (!Number.isFinite(postId) || postId <= 0) return json(res, 400, { error: "Invalid post id" });
  const live = await requireLivePost(postId);
  // Replies can be reposted like posts (founder, 2026-10-03).
  if (!live) return json(res, 404, { error: "Post not found" });

  const address = session.walletAddress;
  const existing = await pool.query(
    `select 1 from public.social_post_reposts
      where post_id = $1 and (author_address = $2 or lower(author_address) = lower($2))
      limit 1`,
    [postId, address],
  );
  if (existing.rows.length) {
    await pool.query(
      `delete from public.social_post_reposts
        where post_id = $1 and (author_address = $2 or lower(author_address) = lower($2))`,
      [postId, address],
    );
    const { rows } = await pool.query(`select count(*)::int as n from public.social_post_reposts where post_id = $1`, [postId]);
    return json(res, 200, { ok: true, on: false, repostCount: Number(rows[0]?.n || 0) });
  }

  if ((await countRecent("public.social_post_reposts", address)) >= REPOST_RATE_LIMIT) {
    return json(res, 429, { error: "Too many reposts. Wait a few minutes." });
  }
  await pool.query(
    `insert into public.social_post_reposts (post_id, author_address) values ($1, $2)
     on conflict do nothing`,
    [postId, address],
  );
  void notifyRepost(pool, { postId, actor: address });
  const { rows } = await pool.query(`select count(*)::int as n from public.social_post_reposts where post_id = $1`, [postId]);
  return json(res, 200, { ok: true, on: true, repostCount: Number(rows[0]?.n || 0) });
}

async function handleReply(req, res) {
  const session = await feedSession.requireSession(req, res);
  if (!session) return;
  const b = req.body && typeof req.body === "object" && Object.keys(req.body).length ? req.body : await readJson(req);
  const postId = postIdFromReq(req, b);
  if (!Number.isFinite(postId) || postId <= 0) return json(res, 400, { error: "Invalid post id" });
  const live = await requireLivePost(postId);
  // A reply can be answered too (founder, 2026-10-03); its own post page lists those answers.
  if (!live) return json(res, 404, { error: "Post not found" });

  const trimmed = String(b.body ?? "").trim();
  if (!trimmed) return json(res, 400, { error: "Reply is empty" });
  if (trimmed.length > POST_MAX_CHARS) return json(res, 400, { error: `Reply too long (max ${POST_MAX_CHARS})` });

  const address = session.walletAddress;
  const recent = await pool.query(
    `select count(*)::int as n
       from public.social_posts
      where (author_address = $1 or lower(author_address) = lower($1))
        and parent_id is not null
        and created_at > now() - ($2::int * interval '1 minute')`,
    [address, POST_RATE_WINDOW_MINUTES],
  );
  if (Number(recent.rows[0]?.n || 0) >= REPLY_RATE_LIMIT) {
    return json(res, 429, { error: "Too many replies. Wait a few minutes." });
  }

  const mention = await resolveMention(trimmed, b.mentioned || b);
  const { rows } = await pool.query(
    `insert into public.social_posts (
       author_address, body, media_url, mentioned_chain_id, mentioned_campaign, mentioned_token, status, parent_id
     ) values ($1, $2, $3, $4, $5, $6, 0, $7)
     returning id, created_at`,
    [address, trimmed, null, mention.chainId, mention.campaign, mention.token, postId],
  );
  if (rows[0]?.id) void notifySocialPost(pool, { postId: rows[0].id, actor: address, body: trimmed, parentId: postId });
  const { rows: counts } = await pool.query(
    `select count(*)::int as n from public.social_posts where parent_id = $1 and status = 0`,
    [postId],
  );
  return json(res, 200, {
    id: rows[0]?.id ?? null,
    createdAt: rows[0]?.created_at ? new Date(rows[0].created_at).toISOString() : null,
    replyCount: Number(counts[0]?.n || 0),
  });
}

export default async function handler(req, res) {
  try {
    await refreshMediaUrlColumns();
    const path = requestPath(req);
    if (req.method === "GET" && /\/posts\/\d+\/replies\/?$/i.test(path)) return await handleGetReplies(req, res);
    if (req.method === "GET" && /\/posts\/\d+\/?$/i.test(path)) return await handleGetOne(req, res);
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "POST" && /\/feed\/views\/?$/i.test(path)) return await handleViews(req, res);
    if (req.method === "POST" && /\/posts\/\d+\/fire\/?$/i.test(path)) return await handleFire(req, res);
    if (req.method === "POST" && /\/posts\/\d+\/repost\/?$/i.test(path)) return await handleRepost(req, res);
    if (req.method === "POST" && /\/posts\/\d+\/replies\/?$/i.test(path)) return await handleReply(req, res);
    if (req.method === "POST" && /\/posts\/\d+\/delete/i.test(path)) return await handleDelete(req, res);
    if (req.method === "POST") return await handleCreate(req, res);
    return badMethod(res);
  } catch (e) {
    const msg = String(e?.message ?? "");
    const isAuth = /nonce|signature/i.test(msg);
    console.error("[api/feed/posts]", e);
    if (missingTable(e)) {
      if (req.method === "GET") return json(res, 200, { items: [], warning: "social_posts table is not migrated yet" });
      return json(res, 503, { error: "Feed is not migrated yet" });
    }
    return json(res, isAuth ? 401 : 500, { error: isAuth ? msg : "Server error" });
  }
}
