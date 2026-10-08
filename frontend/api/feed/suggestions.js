import { pool } from "../../server/db.js";
import { badMethod, getQuery, json } from "../../server/http.js";
import { canonPostAddress } from "../lib/postsCanon.js";
import { loadFollowingAddresses } from "../lib/socialTimeline.js";
import { isOwnerWallet } from "../../shared/ownerWallets.mjs";

function missingTable(e) {
  return e?.code === "42P01" || e?.code === "42703";
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  try {
    const q = getQuery(req);
    const viewer = canonPostAddress(q.viewer || q.wallet || q.address || "");
    const following = viewer ? await loadFollowingAddresses(viewer) : [];
    const excluded = new Set(
      [viewer, ...following].map((w) => String(w || "").trim().toLowerCase()).filter(Boolean),
    );

    // Accounts already followed are left out inside the query (2026-10-08): the list used to take the
    // top 24 first and drop follows after, so a viewer following those 24 got nothing and the card
    // hid. Candidates are recent posters plus recently named profiles, so new users who have not
    // posted yet are suggested too.
    const { rows } = await pool.query(
      `with candidates as (
         select p.author_address as wallet, max(p.created_at) as active_at
           from public.social_posts p
          where p.status = 0
            and p.parent_id is null
            and p.created_at > now() - interval '30 days'
          group by p.author_address
         union all
         select up.address as wallet, max(coalesce(up.updated_at, up.created_at)) as active_at
           from public.user_profiles up
          where coalesce(up.updated_at, up.created_at) > now() - interval '30 days'
            and up.display_name is not null
            and length(btrim(up.display_name)) > 0
          group by up.address
       ),
       fresh as (
         select min(c.wallet) as wallet, max(c.active_at) as active_at
           from candidates c
          where c.wallet is not null
            and lower(c.wallet) <> all($1::text[])
          group by lower(c.wallet)
       )
       select
         f.wallet as author_address,
         up.display_name,
         up.avatar_url,
         f.active_at as last_posted_at
       from fresh f
       left join lateral (
         select display_name, avatar_url
           from public.user_profiles up
          where lower(up.address) = lower(f.wallet)
          order by
            (up.display_name is not null and length(btrim(up.display_name)) > 0) desc,
            (up.avatar_url is not null and length(btrim(up.avatar_url)) > 0) desc,
            up.updated_at desc nulls last
          limit 1
       ) up on true
       order by
         (up.display_name is not null and length(btrim(up.display_name)) > 0) desc,
         (up.avatar_url is not null and length(btrim(up.avatar_url)) > 0) desc,
         f.active_at desc
       limit 24`,
      [Array.from(excluded)],
    );

    const items = [];
    const seen = new Set();
    for (const row of rows) {
      const wallet = String(row.author_address || "").trim();
      if (!wallet) continue;
      const key = wallet.toLowerCase();
      if (seen.has(key) || excluded.has(key) || isOwnerWallet(wallet)) continue;
      seen.add(key);
      items.push({
        wallet,
        name: row.display_name || null,
        avatar: row.avatar_url || null,
      });
      if (items.length >= 5) break;
    }

    return json(res, 200, { items });
  } catch (e) {
    console.error("[api/feed/suggestions]", e);
    if (missingTable(e)) return json(res, 200, { items: [] });
    return json(res, 500, { error: "Server error" });
  }
}
