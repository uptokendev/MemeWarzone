import { pool } from "../server/db.js";
import { badMethod, getQuery, json, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { cleanPrefs, loadPrefs, prefsWalletKey } from "./lib/notificationPrefs.js";
import { createFeedSessionAuth } from "./lib/feedSessionAuth.js";

const feedSession = createFeedSessionAuth({ pool });

function sameWallet(a, b) {
  const x = String(a || "").trim();
  const y = String(b || "").trim();
  if (!x || !y) return false;
  return x.startsWith("0x") || y.startsWith("0x") ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function maskEmail(email) {
  const [name, domain] = String(email || "").split("@");
  if (!name || !domain) return null;
  return `${name.slice(0, 2)}${"*".repeat(Math.max(1, name.length - 2))}@${domain}`;
}

// The owner's own email status (founder, 2026-10-05: the email switches went grey after every reload
// because the verified state was only known right after saving). Only with the owner's feed session.
async function ownerEmailStatus(req, wallet) {
  if (!/^Bearer\s+\S+/i.test(String(req.headers?.authorization || ""))) return null;
  const quiet = { status() { return this; }, json() { return this; } };
  const session = await feedSession.requireSession(req, quiet).catch(() => null);
  if (!session || !sameWallet(session.walletAddress, wallet)) return null;
  try {
    const { rows } = await pool.query(
      `select email, verified_at from public.wallet_notification_emails
        where wallet = $1 or lower(wallet) = lower($1) order by updated_at desc nulls last limit 1`,
      [wallet],
    );
    const row = rows[0];
    if (!row) return { configured: false, verified: false, email: null };
    return { configured: true, verified: Boolean(row.verified_at), email: maskEmail(row.email) };
  } catch (e) {
    if (e?.code === "42P01") return null;
    throw e;
  }
}

/**
 * Notification toggles (CO-5, founder 2026-10-03).
 *   GET  /api/notification-prefs?wallet=W  -> { supported, prefs } (+ email status for the owner's feed session)
 *   POST /api/notification-prefs { walletAddress, chainId, prefs, auth } (wallet-signed, action notification_prefs_set)
 */
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const wallet = prefsWalletKey(getQuery(req).wallet);
      if (!wallet) return json(res, 400, { error: "wallet is required" });
      const [prefs, email] = await Promise.all([loadPrefs(wallet), ownerEmailStatus(req, wallet)]);
      return json(res, 200, email ? { ...prefs, email } : prefs);
    }
    if (req.method === "POST") {
      const body = req.body && typeof req.body === "object" && Object.keys(req.body).length ? req.body : await readJson(req);
      const wallet = prefsWalletKey(body.walletAddress || body.auth?.walletAddress || "");
      if (!wallet) return json(res, 400, { error: "walletAddress is required" });
      const prefs = cleanPrefs(body.prefs);
      const verified = await requireWalletActionAuth({
        res,
        pool,
        auth: body.auth || body,
        expectedWallet: wallet,
        chainId: Number(body.chainId || body.auth?.chainId || 56),
        action: "notification_prefs_set",
        routeLabel: "notification-prefs",
        extraLines: [`Prefs: ${JSON.stringify(prefs)}`],
        // New endpoint, no legacy clients: always require a valid, fresh signature over these exact prefs.
        strict: true,
      });
      if (!verified) return;
      try {
        await pool.query(
          `insert into public.wallet_notification_prefs (wallet_key, prefs, updated_at)
           values ($1, $2::jsonb, now())
           on conflict (wallet_key) do update set prefs = excluded.prefs, updated_at = now()`,
          [wallet, JSON.stringify(prefs)],
        );
      } catch (e) {
        if (e?.code === "42P01") return json(res, 503, { error: "Notification settings need a database update first.", code: "PREFS_UNAVAILABLE" });
        throw e;
      }
      return json(res, 200, { ok: true, prefs });
    }
    return badMethod(res);
  } catch (e) {
    console.error("[api/notification-prefs]", e);
    return json(res, 500, { error: "Server error" });
  }
}
