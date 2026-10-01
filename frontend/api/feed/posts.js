import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import { badMethod, getQuery, json, readJson } from "../../server/http.js";
import { verifySolanaSignature } from "../lib/walletActionAuth.js";
import {
  POST_MAX_CHARS,
  POST_RATE_LIMIT,
  POST_RATE_WINDOW_MINUTES,
  buildPostCreateMessage,
  buildPostDeleteMessage,
  canonPostWallet,
} from "../lib/postsCanon.js";
import {
  loadCoinDeployedEvents,
  loadDraftCreatedEvents,
  loadFollowingAddresses,
  loadPostEvents,
  loadPublicFeedSystemEvents,
  mergeTimelineItems,
} from "../lib/socialTimeline.js";
import { isSolanaAddress, isSolanaChain } from "../../server/http.js";

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
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

function missingTable(e) {
  return e?.code === "42P01" || e?.code === "42703";
}

async function resolveMention(body, mentioned) {
  const chainHint = Number(mentioned?.chainId);
  const campaign = String(mentioned?.campaign || mentioned?.campaignAddress || "").trim();
  const token = String(mentioned?.token || mentioned?.tokenAddress || "").trim();
  const tickerMatch = String(body || "").match(/\$([A-Za-z0-9]{2,12})\b/);
  const ticker = tickerMatch ? tickerMatch[1] : "";

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

async function loadRecentPosts({ limit, author, authors }) {
  if (author) return loadPostEvents([author], { limit });
  if (Array.isArray(authors) && authors.length) return loadPostEvents(authors, { limit });
  try {
    const { rows } = await pool.query(
      `select
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
         c.name as token_name,
         c.symbol as token_ticker,
         c.logo_uri as token_logo_uri
       from public.social_posts p
       left join public.user_profiles up
         on lower(up.address) = lower(p.author_address)
       left join public.campaigns c
         on p.mentioned_chain_id is not null
        and c.chain_id = p.mentioned_chain_id
        and (
          c.campaign_address = p.mentioned_campaign
          or c.token_address = p.mentioned_token
          or lower(c.campaign_address) = lower(coalesce(p.mentioned_campaign, ''))
          or lower(c.token_address) = lower(coalesce(p.mentioned_token, ''))
        )
      where p.status = 0
      order by p.created_at desc, p.id desc
      limit $1`,
      [limit],
    );
    return rows.map((row) => ({
      type: "post",
      id: `post:${row.id}`,
      postId: Number(row.id),
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
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
    }));
  } catch (e) {
    if (missingTable(e)) return [];
    throw e;
  }
}

async function handleGet(req, res) {
  const q = getQuery(req);
  const limit = clampInt(q.limit, 1, 100, 40);
  const tab = String(q.tab || "").toLowerCase();
  const author = canonPostWallet(q.chainId || (isSolanaAddress(q.author) ? 101 : 0), q.author || "");
  const viewer = String(q.viewer || q.wallet || "").trim();

  if (author && !tab) {
    const items = await loadRecentPosts({ limit, author });
    return json(res, 200, { items, tab: "author", author });
  }

  if (tab === "following") {
    if (!viewer) return json(res, 200, { items: [], tab: "following", warning: "Connect a wallet to load Following." });
    const following = await loadFollowingAddresses(viewer);
    if (!following.length) return json(res, 200, { items: [], tab: "following" });
    const [posts, drafts, deploys] = await Promise.all([
      loadRecentPosts({ limit, authors: following }),
      loadDraftCreatedEvents(following, { limit }),
      loadCoinDeployedEvents(following, { limit }),
    ]);
    return json(res, 200, {
      items: mergeTimelineItems([posts, drafts, deploys], limit),
      tab: "following",
    });
  }

  const [posts, system] = await Promise.all([
    loadRecentPosts({ limit }),
    loadPublicFeedSystemEvents({ limit }),
  ]);
  return json(res, 200, {
    items: mergeTimelineItems([posts, system.drafts, system.deploys], limit),
    tab: "for-you",
  });
}

async function handleCreate(req, res) {
  const b = await readJson(req);
  const chainId = Number(b.chainId);
  const address = canonPostWallet(chainId, b.address);
  const body = String(b.body ?? "");
  const nonce = String(b.nonce ?? "");
  const signature = String(b.signature ?? "");

  if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
  if (!address) return json(res, 400, { error: "Invalid address" });
  const trimmed = body.trim();
  if (!trimmed) return json(res, 400, { error: "Post is empty" });
  if (trimmed.length > POST_MAX_CHARS) return json(res, 400, { error: `Post too long (max ${POST_MAX_CHARS})` });
  if (!nonce) return json(res, 400, { error: "Nonce missing" });
  if (!signature) return json(res, 400, { error: "Signature missing" });

  await consumeNonce(chainId, address, nonce);

  const msg = buildPostCreateMessage({ chainId, address, nonce, body: trimmed });
  const solana = isSolanaChain(chainId) || isSolanaAddress(address);
  if (solana) {
    if (!verifySolanaSignature(msg, signature, address)) return json(res, 401, { error: "Invalid signature" });
  } else {
    const recovered = ethers.verifyMessage(msg, signature).toLowerCase();
    if (recovered !== address) return json(res, 401, { error: "Invalid signature" });
  }

  const recent = await pool.query(
    `select count(*)::int as n
       from public.social_posts
      where (author_address = $1 or lower(author_address) = lower($1))
        and created_at > now() - ($2::int * interval '1 minute')`,
    [address, POST_RATE_WINDOW_MINUTES],
  );
  if (Number(recent.rows[0]?.n || 0) >= POST_RATE_LIMIT) {
    return json(res, 429, { error: "Too many posts. Wait a few minutes." });
  }

  const mention = await resolveMention(trimmed, b.mentioned || b);
  const { rows } = await pool.query(
    `insert into public.social_posts (
       author_address, body, media_url, mentioned_chain_id, mentioned_campaign, mentioned_token, status
     ) values ($1, $2, $3, $4, $5, $6, 0)
     returning id, created_at`,
    [address, trimmed, null, mention.chainId, mention.campaign, mention.token],
  );

  return json(res, 200, {
    id: rows[0]?.id ?? null,
    createdAt: rows[0]?.created_at ? new Date(rows[0].created_at).toISOString() : null,
  });
}

async function handleDelete(req, res) {
  const b = await readJson(req);
  const chainId = Number(b.chainId);
  const address = canonPostWallet(chainId, b.address);
  const nonce = String(b.nonce ?? "");
  const signature = String(b.signature ?? "");
  const postId = Number(req.params?.id ?? b.postId ?? b.id);

  if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
  if (!address) return json(res, 400, { error: "Invalid address" });
  if (!Number.isFinite(postId) || postId <= 0) return json(res, 400, { error: "Invalid post id" });
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

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "POST" && (req.params?.id || /\/posts\/\d+\/delete/i.test(String(req.url || "")))) {
      return await handleDelete(req, res);
    }
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
