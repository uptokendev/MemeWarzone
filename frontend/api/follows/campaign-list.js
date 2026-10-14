import { pool } from "../../server/db.js";
import { badMethod, getQuery, normalizeWalletFlexible, json } from "../../server/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  try {
    const q = getQuery(req);
    // Coin follows are chainless (see follows/campaign.js): every coin this wallet follows, any chain.
    const user = normalizeWalletFlexible(q.user);
    if (!user) return json(res, 400, { error: "Invalid address" });

    const { rows } = await pool.query(
      `SELECT campaign_address
         FROM public.campaign_follows
        WHERE user_address=$1
     GROUP BY campaign_address
     ORDER BY max(created_at) DESC
        LIMIT 500`,
      [user]
    );

    return json(res, 200, { items: (rows || []).map((r) => r.campaign_address) });
  } catch (e) {
    console.error("follows/campaign-list error", e);
    return json(res, 500, { error: "Internal error" });
  }
}