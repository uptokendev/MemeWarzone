import { pool } from "../../server/db.js";
import { badMethod, getQuery, normalizeWalletFlexible, json } from "../../server/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  try {
    const q = getQuery(req);
    // Follows are wallet to wallet and may cross wallet types (a Solana wallet following an EVM
    // wallet, founder 2026-10-05), so the address is read by its own format and every chain counts.
    const raw = String(q.address ?? "").trim();
    const type = String(q.type ?? "").toLowerCase();
    const addr = normalizeWalletFlexible(raw);
    if (!addr) return json(res, 400, { error: "Invalid address" });
    if (type !== "followers" && type !== "following") return json(res, 400, { error: "Invalid type" });

    // Distinct counterparties; include legacy EVM rows stored under 56/97.
    const sql =
      type === "followers"
        ? `SELECT DISTINCT ON (uf.follower_address)
                  uf.follower_address AS addr,
                  up.display_name AS "displayName",
                  up.avatar_url AS "avatarUrl",
                  uf.created_at
             FROM public.user_follows uf
        LEFT JOIN public.user_profiles up
               ON lower(up.address) = lower(uf.follower_address)
            WHERE uf.following_address = $1
         ORDER BY uf.follower_address, uf.created_at DESC
            LIMIT 200`
        : `SELECT DISTINCT ON (uf.following_address)
                  uf.following_address AS addr,
                  up.display_name AS "displayName",
                  up.avatar_url AS "avatarUrl",
                  uf.created_at
             FROM public.user_follows uf
        LEFT JOIN public.user_profiles up
               ON lower(up.address) = lower(uf.following_address)
            WHERE uf.follower_address = $1
         ORDER BY uf.following_address, uf.created_at DESC
            LIMIT 200`;

    const { rows } = await pool.query(sql, [addr]);
    rows.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
    return json(res, 200, {
      items: (rows || []).map((r) => ({
        address: r.addr,
        profile: { displayName: r.displayName ?? null, avatarUrl: r.avatarUrl ?? null },
      })),
    });
  } catch (e) {
    console.error("follows/user-list error", e);
    return json(res, 500, { error: "Internal error" });
  }
}