/**
 * Coin page API (UI redesign phase 1b): coin page fields (N5), posts written as the coin (N1) and
 * auto updates (N4). Additive: new routes, new columns on token_story_profiles that the Story save
 * never writes, and the new coin_posts table. Spec: docs/build_plans/ui-redesign/CHANGELOG.md.
 *
 *   GET  /api/coin-page?chainId=&token=
 *   POST /api/coin-page/profile            signed coin_page_profile_update
 *   POST /api/coin-page/posts              signed coin_post_create, or the owner's feed session
 *   POST /api/coin-page/posts/:id/delete   signed coin_post_delete, or the owner's feed session
 *   POST /api/coin-page/image?…&slot=      multipart, signed coin_page_image (see coinPageImage)
 */
import { pool } from "../server/db.js";
import { getQuery, json, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { createFeedSessionAuth } from "./lib/feedSessionAuth.js";
import { coinIdent, coinPageOwner, isSolanaChain } from "./lib/coinPageOwner.js";
import {
  COIN_POST_RATE,
  buildAutoUpdates,
  isOwnCoinImage,
  postFromRow,
  profileFromRow,
  validateCoinPostInput,
  validateCoinProfileInput,
} from "./lib/coinPageCanon.js";

const PROFILE_COLUMNS = [
  "banner_url", "bio", "founder_note", "website_url", "x_url", "telegram_url", "discord_url",
  "tags", "pinned_post_id", "share_updates_to_feed", "show_auto_updates", "section_images",
  "banner_position_y",
];

/** Every stored image must be this coin's own upload (see coinPageImage.js). */
function imageAllowed(url, chainId, token) {
  if (!url) return true;
  return isOwnCoinImage(url, { storageBase: process.env.SUPABASE_URL, chainId, token });
}

/** A missing column/table (migration not applied yet) reads as "nothing written". */
function isSchemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function sameAddr(chainId, a, b) {
  if (!a || !b) return false;
  return isSolanaChain(chainId) ? String(a) === String(b) : String(a).toLowerCase() === String(b).toLowerCase();
}

async function readProfile(chainId, token) {
  try {
    const match = isSolanaChain(chainId) ? "token_address = $2" : "lower(token_address) = lower($2)";
    const read = (columns) =>
      pool.query(
        `select ${columns.join(", ")}, short_story, sections, updated_at from public.token_story_profiles where chain_id = $1 and ${match} limit 1`,
        [chainId, token],
      );
    try {
      const { rows } = await read(PROFILE_COLUMNS);
      return rows[0] || null;
    } catch (error) {
      // banner_position_y (20261002_000006) not applied yet: read everything else.
      if (error?.code !== "42703") throw error;
      const { rows } = await read(PROFILE_COLUMNS.filter((c) => c !== "banner_position_y"));
      return rows[0] || null;
    }
  } catch (error) {
    if (isSchemaMissing(error)) return null;
    throw error;
  }
}

async function readPosts(chainId, token, limit = 50) {
  try {
    const match = isSolanaChain(chainId) ? "token_address = $2" : "lower(token_address) = lower($2)";
    const { rows } = await pool.query(
      `select id, body, media_url, share_to_feed, created_at from public.coin_posts
        where chain_id = $1 and ${match} and status = 0 order by created_at desc limit $3`,
      [chainId, token, limit],
    );
    return rows.map(postFromRow);
  } catch (error) {
    if (isSchemaMissing(error)) return [];
    throw error;
  }
}

async function readAutoFacts(chainId, ids) {
  const keys = ids.filter(Boolean);
  if (!keys.length) return {};
  const where = isSolanaChain(chainId)
    ? "(token_address = any($2::text[]) or campaign_address = any($2::text[]))"
    : "(lower(token_address) = any($2::text[]) or lower(campaign_address) = any($2::text[]))";
  const lowered = isSolanaChain(chainId) ? keys : keys.map((k) => String(k).toLowerCase());
  const camp = (await pool.query(
    `select token_address, campaign_address, created_at_chain, graduated_at_chain from public.campaigns where chain_id = $1 and ${where} limit 1`,
    [chainId, lowered],
  ).catch((e) => (isSchemaMissing(e) ? { rows: [] } : Promise.reject(e)))).rows[0];
  const battleKeys = [...new Set([...keys, camp?.token_address, camp?.campaign_address].filter(Boolean).map(String))];
  const battles = (await pool.query(
    `select id, battle_mode, winner_token, challenger_token, defender_token, participants,
            coalesce(finished_at, settled_at, started_at) as at
       from public.arena_battles
      where chain_id = $1 and state = 'finished' and winner_token is not null
        and (challenger_token = any($2::text[]) or defender_token = any($2::text[]))
      order by coalesce(finished_at, settled_at, started_at) desc
      limit 10`,
    [chainId, battleKeys],
  ).catch((e) => (isSchemaMissing(e) ? { rows: [] } : Promise.reject(e)))).rows;
  return {
    launchedAt: camp?.created_at_chain || null,
    graduatedAt: camp?.graduated_at_chain || null,
    battles: battles.map((row) => {
      const mine = battleKeys.some((k) => sameAddr(chainId, k, row.challenger_token)) ? row.challenger_token : row.defender_token;
      const rivalToken = sameAddr(chainId, mine, row.challenger_token) ? row.defender_token : row.challenger_token;
      const parts = Array.isArray(row.participants) ? row.participants : [];
      const rival = parts.find((p) => [p?.tokenAddress, p?.tokenId, p?.campaignAddress].some((v) => sameAddr(chainId, v, rivalToken))) || {};
      return {
        id: String(row.id),
        at: row.at,
        won: sameAddr(chainId, row.winner_token, mine),
        rivalTicker: rival.symbol ? String(rival.symbol) : null,
        mode: row.battle_mode === "vote" ? "vote" : "metrics",
      };
    }),
  };
}

async function handleGet(req, res) {
  const q = getQuery(req);
  const chainId = Number(q.chainId || 0);
  const token = coinIdent(chainId, q.token);
  if (!chainId || !token) return json(res, 400, { error: "chainId and token are required", code: "COIN_IDENTITY_REQUIRED" });
  const owner = await coinPageOwner(pool, chainId, token);
  const key = owner?.token || token;
  const [row, posts, facts] = await Promise.all([readProfile(chainId, key), readPosts(chainId, key), readAutoFacts(chainId, [token, key])]);
  const profile = profileFromRow(row);
  return json(res, 200, {
    owner: owner ? { wallet: owner.wallet, origin: owner.origin, token: owner.token } : null,
    profile,
    // The Story's own text exactly as stored, so an editor can send it back to POST /api/story/profile
    // (which replaces both fields) without losing anything. Read-only here.
    storyText: { shortStory: row?.short_story || null, sections: row?.sections && typeof row.sections === "object" ? row.sections : {} },
    posts,
    autoUpdates: profile.showAutoUpdates ? buildAutoUpdates(facts) : [],
  });
}

const feedSession = createFeedSessionAuth({ pool });

function sameWallet(a, b) {
  const x = String(a || "").trim();
  const y = String(b || "").trim();
  if (!x || !y) return false;
  return x.startsWith("0x") || y.startsWith("0x") ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Resolves the owner and checks the signature. Returns { owner, verified } or null after replying.
 * With `req` (creator updates only, founder 2026-10-03) a feed session whose wallet is the owner counts
 * instead of a signature: one signature per 30 days covers posting. Profile, story and images stay signed.
 */
async function authorizeOwner(res, body, action, extraLines = [], req = null) {
  const chainId = Number(body.chainId || 0);
  const token = coinIdent(chainId, body.token);
  if (!chainId || !token) {
    json(res, 400, { error: "chainId and token are required", code: "COIN_IDENTITY_REQUIRED" });
    return null;
  }
  const owner = await coinPageOwner(pool, chainId, token);
  if (!owner) {
    json(res, 403, { error: "Only the verified owner of this coin can do this.", code: "COIN_NOT_OWNER" });
    return null;
  }
  if (req && /^Bearer\s+\S+/i.test(String(req.headers?.authorization || ""))) {
    const session = await feedSession.requireSession(req, res);
    if (!session) return null;
    if (!sameWallet(session.walletAddress, owner.wallet)) {
      json(res, 403, { error: "Only the verified owner of this coin can do this.", code: "COIN_NOT_OWNER" });
      return null;
    }
    return { chainId, owner, verified: { walletAddress: owner.wallet } };
  }
  const verified = await requireWalletActionAuth({
    res, pool, auth: body.auth, expectedWallet: owner.wallet, chainId, action,
    routeLabel: `coin-page/${action}`, extraLines: [`Token: ${owner.token}`, ...extraLines], strict: true,
  });
  if (!verified) return null;
  return { chainId, owner, verified };
}

async function handleProfileWrite(req, res) {
  const body = await readJson(req);
  const auth = await authorizeOwner(res, body, "coin_page_profile_update");
  if (!auth) return;
  const { chainId, owner, verified } = auth;
  const checked = validateCoinProfileInput(body.profile, owner.origin);
  if (!checked.ok) return json(res, 400, { error: checked.error, code: checked.code, field: checked.field });
  const values = checked.values;
  const images = [values.banner_url, ...Object.values(values.section_images || {})];
  if (images.some((url) => !imageAllowed(url, chainId, owner.token))) {
    return json(res, 400, { error: "Images must be uploaded on this page.", code: "COIN_IMAGE_FOREIGN" });
  }

  if (values.pinned_post_id) {
    const { rows } = await pool.query(
      `select 1 from public.coin_posts where id = $1 and chain_id = $2 and token_address = $3 and status = 0 limit 1`,
      [values.pinned_post_id, chainId, owner.token],
    );
    if (!rows.length) return json(res, 400, { error: "Pick one of this coin's posts to pin.", code: "COIN_PIN_INVALID" });
  }

  const columns = Object.keys(values);
  const params = [chainId, owner.token, verified.walletAddress];
  const placeholders = columns.map((column) => {
    const v = values[column];
    params.push(column === "section_images" && v != null ? JSON.stringify(v) : v);
    const cast = column === "section_images" ? "::jsonb" : column === "tags" ? "::text[]" : column === "pinned_post_id" ? "::bigint" : column === "banner_position_y" ? "::smallint" : "";
    return `$${params.length}${cast}`;
  });
  // Insert creates the row with the Story's own defaults; on conflict only the columns sent are set,
  // so short_story and sections (owned by POST /api/story/profile) are never touched.
  await pool.query(
    `insert into public.token_story_profiles (chain_id, token_address, updated_by, updated_at, ${columns.join(", ")})
     values ($1, $2, $3, now(), ${placeholders.join(", ")})
     on conflict (chain_id, token_address) do update set ${columns.map((c) => `${c} = excluded.${c}`).join(", ")},
       updated_by = excluded.updated_by, updated_at = now()`,
    params,
  );
  return json(res, 200, { ok: true, profile: profileFromRow(await readProfile(chainId, owner.token)) });
}

async function handlePostCreate(req, res) {
  const body = await readJson(req);
  const checked = validateCoinPostInput(body.post);
  if (!checked.ok) return json(res, 400, { error: checked.error, code: checked.code });
  const auth = await authorizeOwner(res, body, "coin_post_create", [], req);
  if (!auth) return;
  const { chainId, owner, verified } = auth;
  const { body: text, media_url, share_to_feed } = checked.values;
  if (!imageAllowed(media_url, chainId, owner.token)) {
    return json(res, 400, { error: "Images must be uploaded on this page.", code: "COIN_IMAGE_FOREIGN" });
  }
  const recent = await pool.query(
    `select count(*)::int as n from public.coin_posts
      where chain_id = $1 and token_address = $2 and created_at > now() - ($3 || ' minutes')::interval`,
    [chainId, owner.token, String(COIN_POST_RATE.windowMinutes)],
  );
  if (Number(recent.rows[0]?.n || 0) >= COIN_POST_RATE.count) {
    return json(res, 429, { error: `At most ${COIN_POST_RATE.count} posts per ${COIN_POST_RATE.windowMinutes} minutes.`, code: "COIN_POST_RATE_LIMIT" });
  }
  const { rows } = await pool.query(
    `insert into public.coin_posts (chain_id, token_address, author_wallet, body, media_url, share_to_feed)
     values ($1, $2, $3, $4, $5, $6) returning id, body, media_url, share_to_feed, created_at`,
    [chainId, owner.token, verified.walletAddress, text, media_url, share_to_feed],
  );
  return json(res, 200, { ok: true, post: postFromRow(rows[0]) });
}

async function handlePostDelete(req, res, postId) {
  const body = await readJson(req);
  if (!/^\d{1,18}$/.test(String(postId))) return json(res, 400, { error: "Unknown post", code: "COIN_POST_UNKNOWN" });
  const auth = await authorizeOwner(res, body, "coin_post_delete", [`PostId: ${postId}`], req);
  if (!auth) return;
  const { chainId, owner } = auth;
  const { rowCount } = await pool.query(
    `update public.coin_posts set status = 2 where id = $1 and chain_id = $2 and token_address = $3 and status = 0`,
    [postId, chainId, owner.token],
  );
  if (!rowCount) return json(res, 404, { error: "Post not found", code: "COIN_POST_UNKNOWN" });
  // A deleted post cannot stay pinned.
  await pool.query(
    `update public.token_story_profiles set pinned_post_id = null, updated_at = now()
      where chain_id = $1 and token_address = $2 and pinned_post_id = $3`,
    [chainId, owner.token, postId],
  ).catch((e) => (isSchemaMissing(e) ? null : Promise.reject(e)));
  return json(res, 200, { ok: true });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const p = String(req.path || new URL(req.url, "http://localhost").pathname).replace(/\/+$/, "");
  try {
    if (method === "GET" && p === "/coin-page") return await handleGet(req, res);
    if (method === "POST" && p === "/coin-page/profile") return await handleProfileWrite(req, res);
    if (method === "POST" && p === "/coin-page/posts") return await handlePostCreate(req, res);
    const del = p.match(/^\/coin-page\/posts\/([^/]+)\/delete$/);
    if (method === "POST" && del) return await handlePostDelete(req, res, decodeURIComponent(del[1]));
    return json(res, 404, { error: `Unknown coin page route: ${p}` });
  } catch (error) {
    if (isSchemaMissing(error)) return json(res, 503, { error: "Coin page storage is not set up yet.", code: "COIN_PAGE_SCHEMA_MISSING" });
    console.error("[api/coin-page]", error);
    return json(res, 503, { error: "Coin page unavailable" });
  }
}
