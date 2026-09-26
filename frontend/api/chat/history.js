import { badMethod, getQuery, json } from "../../server/http.js";
import { mapMessageRow, normalizeAddress } from "./_lib.js";
import { pool } from "../../server/db.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);
  try {
    const q = getQuery(req);
    const chainId = Number(q.chainId);
    const campaignAddress = normalizeAddress(q.campaignAddress);
    const beforeId = q.beforeId != null ? Number(q.beforeId) : null;
    const limit = Math.min(100, Math.max(1, Number(q.limit ?? 50) || 50));

    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
    if (!campaignAddress) return json(res, 400, { error: "Invalid campaignAddress" });

    const { rows } = await pool.query(
      `SELECT id, chain_id, campaign_address, wallet_address, display_name, avatar_url, role, message, client_nonce, created_at
       FROM public.chat_messages
       WHERE chain_id = $1
         AND campaign_address = $2
         AND COALESCE(is_hidden, false) = false
         AND ($3::bigint IS NULL OR id < $3)
       ORDER BY id DESC
       LIMIT $4`,
      [chainId, campaignAddress, Number.isFinite(beforeId) ? beforeId : null, limit]
    );

    const items = rows.map(mapMessageRow).reverse();
    return json(res, 200, {
      items,
      nextBeforeId: rows.length ? Number(rows[rows.length - 1].id) : null,
    });
  } catch (e) {
    const code = String(e?.code || "");
    // History is a public read. If the table is not there yet, show an empty room
    // instead of 500ing the TokenDetails War Room. Schema DDL belongs on join/send.
    if (code === "42P01") return json(res, 200, { items: [], nextBeforeId: null });
    const msg = String(e?.message ?? "");
    console.error("[api/chat/history]", e);
    return json(res, 500, { error: "Server error", details: process.env.NODE_ENV !== "production" ? msg : undefined });
  }
}
