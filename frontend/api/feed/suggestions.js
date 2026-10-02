import { pool } from "../../server/db.js";
import { badMethod, getQuery, json } from "../../server/http.js";
import { canonPostAddress } from "../lib/postsCanon.js";
import { loadFollowingAddresses } from "../lib/socialTimeline.js";

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

    const { rows } = await pool.query(
      `select
         p.author_address,
         up.display_name,
         up.avatar_url,
         max(p.created_at) as last_posted_at
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
       where p.status = 0
         and p.parent_id is null
         and p.created_at > now() - interval '30 days'
       group by p.author_address, up.display_name, up.avatar_url
       order by
         (up.display_name is not null and length(btrim(up.display_name)) > 0) desc,
         (up.avatar_url is not null and length(btrim(up.avatar_url)) > 0) desc,
         max(p.created_at) desc
       limit 24`,
    );

    const items = [];
    const seen = new Set();
    for (const row of rows) {
      const wallet = String(row.author_address || "").trim();
      if (!wallet) continue;
      const key = wallet.toLowerCase();
      if (seen.has(key) || excluded.has(key)) continue;
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
