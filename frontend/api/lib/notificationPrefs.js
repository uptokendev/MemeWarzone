import { pool } from "../../server/db.js";
import { normalizeWalletFlexible } from "../../server/http.js";

/**
 * Notification toggles (CO-5, founder 2026-10-03). Categories and channels; a missing value means on,
 * so wallets that never saved keep today's behaviour. Every read tolerates the table not existing yet.
 */
export const NOTIFICATION_CATEGORIES = ["battles", "social", "rewards", "coin"];
export const NOTIFICATION_CHANNELS = ["bell", "email"];

export function prefsWalletKey(value) {
  return normalizeWalletFlexible(value) || String(value || "").trim();
}

/** Keep only known categories/channels with boolean values. */
export function cleanPrefs(input) {
  const out = {};
  const src = input && typeof input === "object" ? input : {};
  for (const category of NOTIFICATION_CATEGORIES) {
    const row = src[category] && typeof src[category] === "object" ? src[category] : {};
    out[category] = {};
    for (const channel of NOTIFICATION_CHANNELS) out[category][channel] = row[channel] === false ? false : true;
  }
  return out;
}

export async function loadPrefs(wallet) {
  const key = prefsWalletKey(wallet);
  if (!key || !pool) return { supported: false, prefs: cleanPrefs({}) };
  try {
    const { rows } = await pool.query(`select prefs from public.wallet_notification_prefs where wallet_key = $1 limit 1`, [key]);
    return { supported: true, prefs: cleanPrefs(rows[0]?.prefs || {}) };
  } catch (e) {
    if (e?.code === "42P01") return { supported: false, prefs: cleanPrefs({}) };
    throw e;
  }
}

/** True unless the wallet turned this channel off for this category. Errors count as allowed. */
export async function notificationAllowed(wallet, category, channel = "email") {
  try {
    const { prefs } = await loadPrefs(wallet);
    return prefs?.[category]?.[channel] !== false;
  } catch {
    return true;
  }
}
