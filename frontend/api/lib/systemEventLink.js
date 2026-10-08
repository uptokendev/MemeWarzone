import { pool } from "../../server/db.js";

/**
 * Auto updates (launches, graduations, prepare pages, battles) carry a linked social_posts row
 * (social_posts.system_event_key = the feed item id) so they take views, rockets, reposts, quotes and
 * comments like any post (founder, 2026-10-08). Every reader checks once whether the column exists:
 * before the migration runs nothing is linked and the feed keeps working.
 */
let ready = null;
export function hasSystemEventLink() {
  if (!ready) {
    ready = pool
      .query(
        `select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'social_posts' and column_name = 'system_event_key' limit 1`,
      )
      .then((r) => r.rowCount > 0)
      .catch(() => false);
    ready.then((ok) => {
      if (!ok) setTimeout(() => { ready = null; }, 60_000).unref?.();
    });
  }
  return ready;
}

export const SYSTEM_EVENT_TYPES = new Set(["coin_deployed", "coin_graduated", "draft_created", "battle_started", "battle_finished"]);

function tickerOf(item) {
  const t = String(item.ticker || item.campaignSymbol || "").trim().replace(/^\$/, "");
  return t ? `$${t}` : String(item.name || item.campaignName || "A coin").trim();
}

/** The linked row's text: what the card says, so a repost or the post page reads right. */
export function systemEventBody(item) {
  const coin = tickerOf(item);
  let text;
  if (item.type === "coin_graduated") text = `${coin} graduated. It now trades on its DEX.`;
  else if (item.type === "draft_created") text = `${coin} is being prepared on MemeWarzone.`;
  else if (item.type === "battle_started" || item.type === "battle_finished") {
    const sides = (item.sides || []).map((s) => (s?.symbol ? `$${String(s.symbol).replace(/^\$/, "")}` : "?"));
    const pair = sides.length >= 2 ? `${sides[0]} vs ${sides[1]}` : "A battle";
    text = item.type === "battle_finished" ? `${pair}: the battle has a winner.` : `${pair}: the battle is live.`;
  } else text = `${coin} launched on MemeWarzone.`;
  return text.slice(0, 280);
}

/**
 * Creates the linked rows that are missing for these feed items (one insert) and returns
 * Map(itemId -> social_posts.id). Never throws: on any error the cards just show no actions.
 */
export async function ensureSystemEventPosts(items) {
  const out = new Map();
  if (!items.length || !(await hasSystemEventLink())) return out;
  try {
    const rows = items.map((item) => ({
      key: String(item.id),
      author: String(item.wallet || "memewarzone"),
      body: systemEventBody(item),
      chainId: Number(item.chainId) || null,
      campaign: item.campaignAddress || null,
      token: item.tokenAddress || null,
      at: item.createdAt || new Date().toISOString(),
    }));
    await pool.query(
      `insert into public.social_posts (author_address, body, mentioned_chain_id, mentioned_campaign, mentioned_token, status, created_at, system_event_key)
       select a, b, c, d, e, 0, f, g
         from unnest($1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::timestamptz[], $7::text[]) as t(a, b, c, d, e, f, g)
       on conflict do nothing`,
      [
        rows.map((r) => r.author),
        rows.map((r) => r.body),
        rows.map((r) => r.chainId),
        rows.map((r) => r.campaign),
        rows.map((r) => r.token),
        rows.map((r) => r.at),
        rows.map((r) => r.key),
      ],
    );
    const { rows: found } = await pool.query(
      `select id, system_event_key from public.social_posts where status = 0 and system_event_key = any($1::text[])`,
      [rows.map((r) => r.key)],
    );
    for (const row of found) out.set(String(row.system_event_key), Number(row.id));
  } catch (e) {
    console.warn("[systemEventLink] link failed", e?.message || e);
  }
  return out;
}
