import { pool } from "../../server/db.js";
import { badMethod, getQuery, normalizeWalletFlexible, json } from "../../server/http.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  try {
    const q = getQuery(req);
    // The address by its own format, whatever chain the page sends (follows cross wallet types).
    const raw = String(q.address ?? "").trim();
    const addr = normalizeWalletFlexible(raw);
    if (!addr) return json(res, 400, { error: "Invalid address" });

    // Distinct counterparties so legacy multi-chain rows for the same pair count once.
    const [followersRes, followingRes] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT follower_address)::int AS c
           FROM public.user_follows
          WHERE following_address = $1`,
        [addr],
      ),
      pool.query(
        `SELECT COUNT(DISTINCT following_address)::int AS c
           FROM public.user_follows
          WHERE follower_address = $1`,
        [addr],
      ),
    ]);

    return json(res, 200, {
      followers: followersRes.rows?.[0]?.c ?? 0,
      following: followingRes.rows?.[0]?.c ?? 0,
    });
  } catch (e) {
    console.error("follows/user-counts error", e);
    return json(res, 500, { error: "Internal error" });
  }
}
