import { pool } from "../server/db.js";
import { badMethod, getQuery, json, normalizeWalletFlexible, readJson } from "../server/http.js";
import { createFeedSessionAuth } from "./lib/feedSessionAuth.js";

/**
 * Block and hide (CO-30, founder 2026-10-03). Per wallet, only changes what that wallet sees.
 * Blocking an account never touches its coin pages or trading.
 *   GET  /api/moderation?wallet=W  -> { supported, blocked: [walletKey], hidden: ["type:id"] }
 *   POST /api/moderation (feed session: Authorization Bearer) { action, target?, itemType?, itemId? }
 *        action: block | unblock | hide | unhide
 */
const ITEM_TYPES = new Set(["post", "comment", "coin_post", "battle_comment"]);

function walletKey(value) {
  return normalizeWalletFlexible(value) || "";
}

function missingTable(e) {
  return e?.code === "42P01";
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const wallet = walletKey(getQuery(req).wallet);
      if (!wallet) return json(res, 400, { error: "wallet is required" });
      try {
        const [blocks, hidden] = await Promise.all([
          pool.query(`select blocked_key from public.user_blocks where blocker_key = $1 order by created_at desc limit 2000`, [wallet]),
          pool.query(`select item_type, item_id from public.user_hidden_items where viewer_key = $1 order by created_at desc limit 5000`, [wallet]),
        ]);
        return json(res, 200, {
          supported: true,
          blocked: blocks.rows.map((r) => r.blocked_key),
          hidden: hidden.rows.map((r) => `${r.item_type}:${r.item_id}`),
        });
      } catch (e) {
        if (missingTable(e)) return json(res, 200, { supported: false, blocked: [], hidden: [] });
        throw e;
      }
    }

    if (req.method === "POST") {
      const actor = await createFeedSessionAuth({ pool }).requireSession(req, res);
      if (!actor) return;
      const viewer = walletKey(actor.walletAddress);
      const body = req.body && typeof req.body === "object" && Object.keys(req.body).length ? req.body : await readJson(req);
      const action = String(body.action || "");
      try {
        if (action === "block" || action === "unblock") {
          const target = walletKey(body.target);
          if (!target) return json(res, 400, { error: "target wallet is required" });
          if (target === viewer) return json(res, 400, { error: "You cannot block yourself." });
          if (action === "block") {
            await pool.query(
              `insert into public.user_blocks (blocker_key, blocked_key) values ($1, $2) on conflict do nothing`,
              [viewer, target],
            );
          } else {
            await pool.query(`delete from public.user_blocks where blocker_key = $1 and blocked_key = $2`, [viewer, target]);
          }
          return json(res, 200, { ok: true, action, target });
        }
        if (action === "hide" || action === "unhide") {
          const itemType = String(body.itemType || "");
          const itemId = String(body.itemId || "").trim().slice(0, 128);
          if (!ITEM_TYPES.has(itemType) || !itemId) return json(res, 400, { error: "itemType and itemId are required" });
          if (action === "hide") {
            await pool.query(
              `insert into public.user_hidden_items (viewer_key, item_type, item_id) values ($1, $2, $3) on conflict do nothing`,
              [viewer, itemType, itemId],
            );
          } else {
            await pool.query(`delete from public.user_hidden_items where viewer_key = $1 and item_type = $2 and item_id = $3`, [viewer, itemType, itemId]);
          }
          return json(res, 200, { ok: true, action, itemType, itemId });
        }
        return json(res, 400, { error: "Unknown action" });
      } catch (e) {
        if (missingTable(e)) return json(res, 503, { error: "Block and hide need a database update first.", code: "MODERATION_UNAVAILABLE" });
        throw e;
      }
    }
    return badMethod(res);
  } catch (e) {
    console.error("[api/moderation]", e);
    return json(res, 500, { error: "Server error" });
  }
}
