import { pool } from "../../server/db.js";
import { hasSystemEventLink } from "./systemEventLink.js";

/**
 * Creator updates (coin_posts) carry a linked social_posts row (social_posts.coin_post_id) so they take
 * reactions like any post (founder, 2026-10-03). Every reader checks once whether the column exists:
 * before the migration runs, nothing filters on it and nothing is linked, so the feed keeps working.
 */
let ready = null;
export function hasCoinPostLink() {
  if (!ready) {
    ready = pool
      .query(
        `select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'social_posts' and column_name = 'coin_post_id' limit 1`,
      )
      .then((r) => r.rowCount > 0)
      .catch(() => false);
    // Re-check later when the column was missing, so a migration run after start-up is picked up.
    ready.then((ok) => {
      if (!ok) setTimeout(() => { ready = null; }, 60_000).unref?.();
    });
  }
  return ready;
}

/**
 * SQL fragment that keeps linked rows out of regular post lists ("" before the migration): creator
 * update rows (coin_post_id) and, since 2026-10-08, auto update rows (system_event_key).
 */
export async function notCoinPostSql(alias = "p") {
  const [coin, system] = await Promise.all([hasCoinPostLink(), hasSystemEventLink()]);
  return `${coin ? ` and ${alias}.coin_post_id is null` : ""}${system ? ` and ${alias}.system_event_key is null` : ""}`;
}

/** Creates the linked row for a new coin post. Never fails the coin post itself. */
export async function linkCoinPost(client, { coinPostId, authorWallet, body, mediaUrl, chainId, token }) {
  if (!(await hasCoinPostLink())) return null;
  try {
    const { rows } = await (client || pool).query(
      `insert into public.social_posts (author_address, body, media_url, mentioned_chain_id, mentioned_token, status, coin_post_id)
       values ($1, $2, $3, $4, $5, 0, $6)
       on conflict do nothing
       returning id`,
      [authorWallet, body, mediaUrl || null, chainId, token, coinPostId],
    );
    return rows[0]?.id ?? null;
  } catch (e) {
    console.warn("[coinPostLink] link failed", e?.message || e);
    return null;
  }
}

/** Removes the linked row from view when its coin post is deleted. */
export async function unlinkCoinPost(coinPostId) {
  if (!(await hasCoinPostLink())) return;
  await pool.query(`update public.social_posts set status = 2 where coin_post_id = $1 and status = 0`, [coinPostId]).catch(() => {});
}
