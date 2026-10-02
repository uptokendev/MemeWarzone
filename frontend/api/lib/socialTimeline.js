import { pool } from "../../server/db.js";
import { isSolanaAddress } from "../../server/http.js";
import { mergeTimelineItems } from "./socialTimelineMerge.js";

export { mergeTimelineItems };

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function walletParams(wallet) {
  return [wallet, wallet.toLowerCase()];
}

function mapDraftCreated(row) {
  return {
    type: "draft_created",
    id: `draft:${row.id}`,
    createdAt: iso(row.created_at),
    wallet: row.creator_wallet,
    chainId: Number(row.chain_id) || null,
    campaignAddress: row.campaign_address || null,
    tokenAddress: row.token_address || null,
    name: row.name || null,
    ticker: row.ticker || null,
    logoUri: row.logo_url || null,
    slug: row.slug || null,
    draftId: row.id,
  };
}

function mapCoinDeployed(row) {
  const createdAt = iso(row.deployed_at || row.created_at_chain || row.created_at);
  return {
    type: "coin_deployed",
    id: `deploy:${row.chain_id}:${row.campaign_address || row.token_address || row.id}`,
    createdAt,
    wallet: row.creator_address || row.creator_wallet,
    chainId: Number(row.chain_id) || null,
    campaignAddress: row.campaign_address || null,
    tokenAddress: row.token_address || null,
    name: row.name || null,
    ticker: row.symbol || row.ticker || null,
    logoUri: row.logo_uri || row.logo_url || null,
  };
}

function mapTrade(row) {
  return {
    type: "trade",
    id: String(row.id),
    createdAt: iso(row.blockTime),
    wallet: row.wallet,
    chainId: Number(row.chain_id) || null,
    txHash: row.txHash,
    logIndex: Number(row.logIndex || 0),
    blockNumber: Number(row.blockNumber || 0),
    blockTime: iso(row.blockTime),
    side: String(row.side || "buy") === "sell" ? "sell" : "buy",
    tokenAmount: row.tokenAmount == null ? null : Number(row.tokenAmount),
    bnbAmount: row.bnbAmount == null ? null : Number(row.bnbAmount),
    priceBnb: row.priceBnb == null ? null : Number(row.priceBnb),
    campaignAddress: row.campaignAddress || null,
    tokenAddress: row.tokenAddress || null,
    campaignName: row.campaignName || null,
    campaignSymbol: row.campaignSymbol || null,
    logoUri: row.logoUri || null,
  };
}

function mapPost(row) {
  return {
    type: "post",
    id: `post:${row.id}`,
    postId: Number(row.id),
    createdAt: iso(row.created_at),
    wallet: row.author_address,
    body: row.body,
    mediaUrl: row.media_url || null,
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
  };
}

export async function loadDraftCreatedEvents(wallets, { limit = 50 } = {}) {
  const list = (wallets || []).map((w) => String(w || "").trim()).filter(Boolean);
  if (!list.length) return [];
  const { rows } = await pool.query(
    `select d.id, d.chain_id, d.creator_wallet, d.name, d.ticker, d.logo_url, d.slug,
            d.campaign_address, d.token_address, d.created_at
       from public.campaign_drafts d
      where d.visibility = 'public'
        and d.status <> 'archived'
        and (
          d.creator_wallet = any($1::text[])
          or lower(d.creator_wallet) = any($2::text[])
        )
      order by d.created_at desc
      limit $3`,
    [list, list.map((w) => w.toLowerCase()), limit],
  );
  return rows.map(mapDraftCreated);
}

export async function loadCoinDeployedEvents(wallets, { limit = 50 } = {}) {
  const list = (wallets || []).map((w) => String(w || "").trim()).filter(Boolean);
  if (!list.length) return [];
  const lowers = list.map((w) => w.toLowerCase());
  const [campaigns, drafts] = await Promise.all([
    pool.query(
      `select c.chain_id, c.campaign_address, c.token_address, c.creator_address,
              c.name, c.symbol, c.logo_uri, c.created_at_chain, c.created_at
         from public.campaigns c
        where c.campaign_address is not null
          and (
            c.creator_address = any($1::text[])
            or lower(c.creator_address) = any($2::text[])
          )
        order by coalesce(c.created_at_chain, c.created_at) desc
        limit $3`,
      [list, lowers, limit],
    ),
    pool.query(
      `select d.id, d.chain_id, d.creator_wallet, d.name, d.ticker, d.logo_url,
              d.campaign_address, d.token_address, d.deployed_at
         from public.campaign_drafts d
        where d.deployed_at is not null
          and d.visibility = 'public'
          and (
            d.creator_wallet = any($1::text[])
            or lower(d.creator_wallet) = any($2::text[])
          )
        order by d.deployed_at desc
        limit $3`,
      [list, lowers, limit],
    ),
  ]);
  const fromCampaigns = campaigns.rows.map(mapCoinDeployed);
  const fromDrafts = drafts.rows.map(mapCoinDeployed);
  const seen = new Set();
  const out = [];
  for (const item of [...fromCampaigns, ...fromDrafts]) {
    const key = `${item.chainId}:${String(item.campaignAddress || item.tokenAddress || item.id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function loadTradeEvents(wallets, { limit = 50 } = {}) {
  const list = (wallets || []).map((w) => String(w || "").trim()).filter(Boolean);
  if (!list.length) return [];
  const { rows } = await pool.query(
    `select
       (t.chain_id::text || ':' || t.tx_hash || ':' || coalesce(t.log_index, 0)::text) as "id",
       t.chain_id,
       t.tx_hash as "txHash",
       coalesce(t.log_index, 0) as "logIndex",
       t.block_number as "blockNumber",
       t.block_time as "blockTime",
       t.side,
       t.wallet,
       t.token_amount as "tokenAmount",
       t.bnb_amount as "bnbAmount",
       t.price_bnb as "priceBnb",
       t.campaign_address as "campaignAddress",
       c.token_address as "tokenAddress",
       c.name as "campaignName",
       c.symbol as "campaignSymbol",
       c.logo_uri as "logoUri"
     from public.curve_trades t
     left join public.campaigns c
       on c.chain_id = t.chain_id
      and c.campaign_address = t.campaign_address
     where t.wallet = any($1::text[])
        or lower(t.wallet) = any($2::text[])
     order by t.block_time desc, t.block_number desc, coalesce(t.log_index, 0) desc
     limit $3`,
    [list, list.map((w) => w.toLowerCase()), limit],
  );
  return rows.map(mapTrade);
}

export async function loadPostEvents(wallets, { limit = 50, all = false } = {}) {
  const list = (wallets || []).map((w) => String(w || "").trim()).filter(Boolean);
  if (!all && !list.length) return [];
  const params = all ? [limit] : [list, list.map((w) => w.toLowerCase()), limit];
  const authorFilter = all
    ? ""
    : `and (
        p.author_address = any($1::text[])
        or lower(p.author_address) = any($2::text[])
      )`;
  const limitPlaceholder = all ? "$1" : "$3";
  const sql = (topLevelOnly) => `
      select
         p.id,
         p.author_address,
         p.body,
         p.media_url,
         p.mentioned_chain_id,
         p.mentioned_campaign,
         p.mentioned_token,
         p.created_at,
         up.display_name as author_display_name,
         up.avatar_url as author_avatar_url,
         coalesce(c.name, ai.name) as token_name,
         coalesce(c.symbol, ai.symbol) as token_ticker,
         coalesce(c.logo_uri, ai.image_url) as token_logo_uri
       from public.social_posts p
       left join lateral (
         select display_name, avatar_url
           from public.user_profiles up
          where lower(up.address) = lower(p.author_address)
          order by
            (up.display_name is not null and length(btrim(up.display_name)) > 0) desc,
            (up.avatar_url is not null and length(btrim(up.avatar_url)) > 0) desc,
            up.updated_at desc nulls last
          limit 1
       ) up on true
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
      where p.status = 0
        ${topLevelOnly ? "and p.parent_id is null" : ""}
        ${authorFilter}
      order by p.created_at desc, p.id desc
      limit ${limitPlaceholder}`;
  try {
    const { rows } = await pool.query(sql(true), params);
    return rows.map(mapPost);
  } catch (e) {
    if (e?.code === "42703") {
      const { rows } = await pool.query(sql(false), params);
      return rows.map(mapPost);
    }
    if (e?.code === "42P01") return [];
    throw e;
  }
}

export async function loadPublicFeedSystemEvents({ limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  const [drafts, deploys] = await Promise.all([
    pool.query(
      `select d.id, d.chain_id, d.creator_wallet, d.name, d.ticker, d.logo_url, d.slug,
              d.campaign_address, d.token_address, d.created_at
         from public.campaign_drafts d
        where d.visibility = 'public'
          and d.status <> 'archived'
        order by d.created_at desc
        limit $1`,
      [cap],
    ),
    pool.query(
      `select c.chain_id, c.campaign_address, c.token_address, c.creator_address,
              c.name, c.symbol, c.logo_uri, c.created_at_chain, c.created_at
         from public.campaigns c
        where c.campaign_address is not null
        order by coalesce(c.created_at_chain, c.created_at) desc
        limit $1`,
      [cap],
    ),
  ]);
  return {
    drafts: drafts.rows.map(mapDraftCreated),
    deploys: deploys.rows.map(mapCoinDeployed),
  };
}

export async function loadFollowingAddresses(viewer) {
  const addr = String(viewer || "").trim();
  if (!addr) return [];
  const { rows } = await pool.query(
    `select distinct following_address as addr
       from public.user_follows
      where follower_address = $1
         or lower(follower_address) = lower($1)
      limit 500`,
    [addr],
  );
  return rows.map((r) => String(r.addr || "").trim()).filter(Boolean);
}

export function normalizeTimelineWallet(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (isSolanaAddress(raw)) return raw;
  return raw;
}

export { walletParams, iso };
