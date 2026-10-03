import { loadHandlesFor, missingHandlesTable, walletKey } from "./userHandles.js";
import { notifyWallet } from "./walletNotify.js";

/**
 * Social notifications (CO-5): replies, quotes, reposts and @mentions. Category "social", so the
 * bell shows them unless that toggle is off, and email goes out in the hourly digest (a viral post
 * never sends one email per reply). Fire-and-forget from the post handlers: never throws.
 */

// Same pattern the feed uses to render @handles (src/components/feed/FeedCards.tsx MENTION_RE).
const MENTION_RE = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{3,20})(?![A-Za-z0-9_])/g;
export const MAX_MENTIONS_PER_POST = 10;

export function parseMentionHandles(body) {
  const out = [];
  const seen = new Set();
  for (const match of String(body || "").matchAll(MENTION_RE)) {
    const handle = match[2].toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
    if (out.length >= MAX_MENTIONS_PER_POST) break;
  }
  return out;
}

async function walletsForHandles(pool, handles) {
  if (!handles.length) return new Map();
  try {
    const { rows } = await pool.query(
      `select lower(handle) as handle, wallet_key from public.user_handles where lower(handle) = any($1::text[])`,
      [handles],
    );
    return new Map(rows.map((r) => [r.handle, r.wallet_key]));
  } catch (e) {
    if (missingHandlesTable(e)) return new Map();
    throw e;
  }
}

async function authorOf(pool, postId) {
  if (!postId) return "";
  const { rows } = await pool.query(`select author_address from public.social_posts where id = $1 and status = 0 limit 1`, [postId]);
  return walletKey(rows[0]?.author_address || "");
}

async function actorLabel(actor) {
  const handles = await loadHandlesFor([actor]).catch(() => new Map());
  const handle = handles.get(walletKey(actor));
  if (handle) return `@${handle}`;
  const w = String(actor || "");
  return w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w || "Someone";
}

function snippet(body) {
  const text = String(body || "").replace(/\s+/g, " ").trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

/**
 * A new post, reply or quote: tells the parent's author (reply), the quoted author (quote) and every
 * @mentioned user, once each, never the actor.
 */
export async function notifySocialPost(pool, { postId, actor, body, parentId = null, quoteOfId = null, notify = notifyWallet } = {}) {
  try {
    const actorKey = walletKey(actor);
    if (!pool || !postId || !actorKey) return { notified: 0 };
    const name = await actorLabel(actorKey);
    const text = snippet(body);
    const told = new Set([actorKey]);
    let notified = 0;
    const send = async (wallet, input) => {
      if (!wallet || told.has(wallet)) return;
      told.add(wallet);
      const r = await notify(pool, { wallet, actorWallet: actorKey, category: "social", targetType: "post", ...input });
      if (r?.inserted) notified += 1;
    };

    if (parentId) {
      await send(await authorOf(pool, parentId), {
        kind: "reply",
        targetId: String(postId),
        dedupeKey: `social:reply:${postId}`,
        title: `${name} replied to your post`,
        body: text,
        target: `/post/${parentId}`,
      });
    }
    if (quoteOfId) {
      await send(await authorOf(pool, quoteOfId), {
        kind: "quote",
        targetId: String(postId),
        dedupeKey: `social:quote:${postId}`,
        title: `${name} quoted your post`,
        body: text,
        target: `/post/${postId}`,
      });
    }
    const wallets = await walletsForHandles(pool, parseMentionHandles(body));
    for (const wallet of wallets.values()) {
      await send(walletKey(wallet), {
        kind: "mention",
        targetId: String(postId),
        dedupeKey: `social:mention:${postId}`,
        title: `${name} mentioned you`,
        body: text,
        target: `/post/${parentId || postId}`,
      });
    }
    return { notified };
  } catch (error) {
    console.warn("[socialNotify] post notifications skipped", error?.message || error);
    return { notified: 0 };
  }
}

/** A repost of someone's post (only on the "on" toggle; undo + redo does not notify twice). */
export async function notifyRepost(pool, { postId, actor, notify = notifyWallet } = {}) {
  try {
    const actorKey = walletKey(actor);
    if (!pool || !postId || !actorKey) return { notified: 0 };
    const author = await authorOf(pool, postId);
    if (!author || author === actorKey) return { notified: 0 };
    const r = await notify(pool, {
      wallet: author,
      actorWallet: actorKey,
      category: "social",
      kind: "repost",
      targetType: "post",
      targetId: String(postId),
      dedupeKey: `social:repost:${postId}:${actorKey}`,
      title: `${await actorLabel(actorKey)} reposted your post`,
      body: "",
      target: `/post/${postId}`,
    });
    return { notified: r?.inserted ? 1 : 0 };
  } catch (error) {
    console.warn("[socialNotify] repost notification skipped", error?.message || error);
    return { notified: 0 };
  }
}
