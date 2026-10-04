import { pool } from "../../server/db.js";

/**
 * Up to 4 images per post (founder, 2026-10-04): social_posts.media_urls / coin_posts.media_urls.
 * Readers ask once whether the columns exist (re-checked every minute while missing), so the feed keeps
 * working before the migration runs. media_url always holds the first image.
 */
export const MAX_POST_IMAGES = 4;

const state = { social: false, coin: false, checkedAt: 0, pending: null };

export async function refreshMediaUrlColumns() {
  const fresh = state.social && state.coin;
  if (fresh || (state.checkedAt && Date.now() - state.checkedAt < 60_000)) return state;
  if (!state.pending) {
    state.pending = pool
      .query(
        `select table_name from information_schema.columns
          where table_schema = 'public' and column_name = 'media_urls' and table_name in ('social_posts', 'coin_posts')`,
      )
      .then(({ rows }) => {
        const names = new Set(rows.map((r) => r.table_name));
        state.social = names.has("social_posts");
        state.coin = names.has("coin_posts");
      })
      .catch(() => {})
      .finally(() => {
        state.checkedAt = Date.now();
        state.pending = null;
      });
  }
  await state.pending;
  return state;
}

/** Select fragment for a table alias: the column when it exists, else a typed null. */
export function mediaUrlsSelect(alias, table = "social") {
  return state[table] ? `${alias}.media_urls` : "null::text[] as media_urls";
}

export function hasMediaUrls(table = "social") {
  return state[table];
}

/** All images of a row in order: media_urls when set, else the single media_url. */
export function rowMediaUrls(row) {
  const list = Array.isArray(row?.media_urls) ? row.media_urls.filter(Boolean) : [];
  if (list.length) return list.slice(0, MAX_POST_IMAGES);
  return row?.media_url ? [row.media_url] : [];
}

/** Clean a client list: strings only, trimmed, no duplicates, at most 4. */
export function cleanMediaUrls(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const v of input) {
    const s = String(v ?? "").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
