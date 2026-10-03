import { pool } from "../server/db.js";
import { badMethod, getQuery, json, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { prefsWalletKey } from "./lib/notificationPrefs.js";
import { cleanDisplayPrefs, loadDisplayPrefs } from "./lib/displayPrefs.js";

/**
 * Portfolio display settings (founder, 2026-10-03): hide native coins and stablecoins, hide holdings
 * under $1. Applies to the Command Center and the public profile list.
 *   GET  /api/display-prefs?wallet=W  -> { supported, prefs }
 *   POST /api/display-prefs { walletAddress, chainId, prefs, auth } (wallet-signed, action display_prefs_set)
 */
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const wallet = prefsWalletKey(getQuery(req).wallet);
      if (!wallet) return json(res, 400, { error: "wallet is required" });
      return json(res, 200, await loadDisplayPrefs(wallet));
    }
    if (req.method === "POST") {
      const body = req.body && typeof req.body === "object" && Object.keys(req.body).length ? req.body : await readJson(req);
      const wallet = prefsWalletKey(body.walletAddress || body.auth?.walletAddress || "");
      if (!wallet) return json(res, 400, { error: "walletAddress is required" });
      const prefs = cleanDisplayPrefs(body.prefs);
      const verified = await requireWalletActionAuth({
        res,
        pool,
        auth: body.auth || body,
        expectedWallet: wallet,
        chainId: Number(body.chainId || body.auth?.chainId || 56),
        action: "display_prefs_set",
        routeLabel: "display-prefs",
        extraLines: [`Prefs: ${JSON.stringify(prefs)}`],
        // New endpoint, no legacy clients: always require a valid, fresh signature over these exact prefs.
        strict: true,
      });
      if (!verified) return;
      try {
        await pool.query(
          `insert into public.wallet_display_prefs (wallet_key, prefs, updated_at)
           values ($1, $2::jsonb, now())
           on conflict (wallet_key) do update set prefs = excluded.prefs, updated_at = now()`,
          [wallet, JSON.stringify(prefs)],
        );
      } catch (e) {
        if (e?.code === "42P01") return json(res, 503, { error: "Display settings need a database update first.", code: "PREFS_UNAVAILABLE" });
        throw e;
      }
      return json(res, 200, { ok: true, prefs });
    }
    return badMethod(res);
  } catch (e) {
    console.error("[api/display-prefs]", e);
    return json(res, 500, { error: "Server error" });
  }
}
