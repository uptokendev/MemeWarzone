import crypto from "node:crypto";

import { normalizeWalletFlexible } from "../../server/http.js";
import { NOTIFICATION_CATEGORIES, loadPrefs } from "./notificationPrefs.js";
import { siteOrigin } from "./notify.js";

/**
 * One bell feed for every category (CO-5). Producers call notifyWallet; the row lands in
 * public.prepare_mode_notifications, which the bell already reads, and doubles as the queue for the
 * hourly email digest (scripts/run-notification-digest.mjs). Battles are mailed immediately by
 * arenaNotify.js, so their rows are written already handled (emailed_at = now()).
 *
 * A row is written when the wallet has the bell OR the email on for that category: the bell hides
 * categories that are off, and the digest only mails categories whose email is on. Never throws:
 * a notification must never break the action that caused it.
 */

const IMMEDIATE_EMAIL_CATEGORIES = new Set(["battles"]);

function clean(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

export function notificationWalletKey(value) {
  return normalizeWalletFlexible(value);
}

export async function notifyWallet(pool, input = {}, { prefsFor = loadPrefs } = {}) {
  try {
    if (!pool) return { inserted: false, reason: "no_db" };
    const wallet = notificationWalletKey(input.wallet);
    if (!wallet) return { inserted: false, reason: "no_wallet" };
    const category = String(input.category || "");
    if (!NOTIFICATION_CATEGORIES.includes(category)) return { inserted: false, reason: "bad_category" };
    const actor = notificationWalletKey(input.actorWallet);
    if (actor && actor === wallet) return { inserted: false, reason: "self" };

    const { prefs } = await prefsFor(wallet).catch(() => ({ prefs: null }));
    const row = prefs?.[category];
    if (row && row.bell === false && row.email === false) return { inserted: false, reason: "off" };

    const kind = clean(input.kind || category, 80) || category;
    const targetType = clean(input.targetType || category, 80) || category;
    const targetId = clean(input.targetId || input.dedupeKey || kind, 120) || kind;
    const title = clean(input.title || "MemeWarzone", 160) || "MemeWarzone";
    const body = clean(input.body || "", 600);
    const dedupeKey = input.dedupeKey ? clean(input.dedupeKey, 240) : null;
    const metadata = { ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}) };
    if (input.target) metadata.target = clean(input.target, 500);
    if (actor) metadata.actor = actor;

    const result = await pool.query(
      `insert into public.prepare_mode_notifications
         (wallet_address, event_type, target_type, target_id, title, body, metadata_json, category, dedupe_key, emailed_at)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, ${IMMEDIATE_EMAIL_CATEGORIES.has(category) ? "now()" : "null"})
       on conflict (wallet_address, dedupe_key) where dedupe_key is not null do nothing
       returning id`,
      [wallet, kind, targetType, targetId, title, body, JSON.stringify(metadata), category, dedupeKey],
    );
    return { inserted: result.rowCount > 0, id: result.rows[0]?.id || null };
  } catch (error) {
    console.warn("[walletNotify] notification not written", input?.category, input?.kind, error?.message || error);
    return { inserted: false, reason: "error" };
  }
}

/* ---------- Signed one-category unsubscribe links (no wallet popup needed) ---------- */

function unsubscribeSecret() {
  const explicit = String(process.env.NOTIFICATION_UNSUBSCRIBE_SECRET || "").trim();
  if (explicit) return explicit;
  // Falls back to a key derived from the mail provider key, so links work wherever mail is sent.
  const mailKey = String(process.env.RESEND_API_KEY || process.env.NOTIFY_RESEND_API_KEY || "").trim();
  return mailKey ? crypto.createHash("sha256").update(`mwz-unsubscribe:${mailKey}`).digest("hex") : "";
}

export function signUnsubscribeToken(wallet, category, secret = unsubscribeSecret()) {
  const key = notificationWalletKey(wallet);
  if (!secret || !key || !NOTIFICATION_CATEGORIES.includes(category)) return null;
  const encoded = Buffer.from(JSON.stringify({ w: key, c: category, v: 1 })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifyUnsubscribeToken(token, secret = unsubscribeSecret()) {
  if (!secret) return null;
  const [encoded, supplied] = String(token || "").split(".");
  if (!encoded || !supplied) return null;
  const expected = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const wallet = notificationWalletKey(payload?.w);
    if (!wallet || !NOTIFICATION_CATEGORIES.includes(payload?.c)) return null;
    return { wallet, category: payload.c };
  } catch {
    return null;
  }
}

export function unsubscribeUrl(wallet, category) {
  const token = signUnsubscribeToken(wallet, category);
  if (!token) return null;
  const apiOrigin = String(process.env.PUBLIC_API_ORIGIN || "https://api.memewar.zone").trim().replace(/\/+$/, "");
  return `${apiOrigin}/api/notification-prefs/unsubscribe?t=${encodeURIComponent(token)}`;
}

export const CATEGORY_LABELS = Object.freeze({
  battles: "Battle challenges",
  social: "Replies, reposts and @mentions",
  rewards: "Rewards ready to claim",
  coin: "Your coin events",
});

/** Absolute link for a notification target ("/post/1" -> https://app.../post/1). */
export function absoluteTarget(target) {
  const value = String(target || "").trim();
  if (!value) return siteOrigin();
  if (/^https?:\/\//i.test(value)) return value;
  return `${siteOrigin()}${value.startsWith("/") ? "" : "/"}${value}`;
}
