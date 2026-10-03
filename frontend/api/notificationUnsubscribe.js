import { pool } from "../server/db.js";
import { badMethod, getQuery } from "../server/http.js";
import { cleanPrefs, loadPrefs } from "./lib/notificationPrefs.js";
import { CATEGORY_LABELS, verifyUnsubscribeToken } from "./lib/walletNotify.js";

/**
 * One-category email unsubscribe from a notification email (CO-5).
 *   GET  /api/notification-prefs/unsubscribe?t=TOKEN  -> confirm page with one button
 *   POST /api/notification-prefs/unsubscribe  t=TOKEN -> sets that category's email to off
 * GET never changes anything: mail scanners open links, and must not unsubscribe anyone.
 * The token is an HMAC over {wallet, category} (walletNotify.signUnsubscribeToken).
 */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function page(res, status, title, bodyHtml) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#0d1014;color:#e8ecf0;font:16px/1.5 system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{max-width:420px;background:#14181d;border:1px solid #242a31;border-radius:14px;padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:#aab2bb;margin:0 0 16px}
button{background:#ff7a1a;color:#140a02;border:0;border-radius:10px;padding:12px 16px;font-weight:700;font-size:15px;cursor:pointer;width:100%}</style></head>
<body><main>${bodyHtml}</main></body></html>`);
}

async function tokenFromPost(req) {
  if (req.body && typeof req.body === "object" && req.body.t) return String(req.body.t);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const form = new URLSearchParams(raw);
  if (form.get("t")) return form.get("t");
  try {
    return String(JSON.parse(raw)?.t || "");
  } catch {
    return "";
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const token = String(getQuery(req).t || "");
      const claim = verifyUnsubscribeToken(token);
      if (!claim) return page(res, 400, "Link not valid", "<h1>This link is not valid</h1><p>Manage email settings in Command Center, Notifications.</p>");
      const label = CATEGORY_LABELS[claim.category];
      return page(
        res,
        200,
        "Stop these emails",
        `<h1>Stop emails for: ${escapeHtml(label)}</h1><p>Other notification emails and the bell stay as they are. You can turn this back on in Command Center, Notifications.</p>
<form method="post" action="/api/notification-prefs/unsubscribe"><input type="hidden" name="t" value="${escapeHtml(token)}"><button type="submit">Stop these emails</button></form>`,
      );
    }
    if (req.method === "POST") {
      const claim = verifyUnsubscribeToken(await tokenFromPost(req));
      if (!claim) return page(res, 400, "Link not valid", "<h1>This link is not valid</h1><p>Manage email settings in Command Center, Notifications.</p>");
      const { supported, prefs } = await loadPrefs(claim.wallet);
      if (!supported) return page(res, 503, "Try again later", "<h1>Settings are unavailable</h1><p>Try again later.</p>");
      const next = cleanPrefs({ ...prefs, [claim.category]: { ...prefs[claim.category], email: false } });
      await pool.query(
        `insert into public.wallet_notification_prefs (wallet_key, prefs, updated_at)
         values ($1, $2::jsonb, now())
         on conflict (wallet_key) do update set prefs = excluded.prefs, updated_at = now()`,
        [claim.wallet, JSON.stringify(next)],
      );
      return page(res, 200, "Emails stopped", `<h1>Done</h1><p>No more emails for: ${escapeHtml(CATEGORY_LABELS[claim.category])}. You can turn them back on in Command Center, Notifications.</p>`);
    }
    return badMethod(res);
  } catch (error) {
    console.error("[api/notification-prefs/unsubscribe]", error);
    return page(res, 500, "Error", "<h1>Something went wrong</h1><p>Try again later.</p>");
  }
}

