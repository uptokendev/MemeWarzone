import { pool } from "../../server/db.js";
import { prefsWalletKey } from "./notificationPrefs.js";

/**
 * Portfolio display settings (founder, 2026-10-03). Both off by default (show everything); every read
 * tolerates the table not existing yet.
 */
export const DISPLAY_PREF_KEYS = ["hideNativeAndStables", "hideSmall"];

export function cleanDisplayPrefs(input) {
  const src = input && typeof input === "object" ? input : {};
  const out = {};
  for (const key of DISPLAY_PREF_KEYS) out[key] = src[key] === true;
  return out;
}

export async function loadDisplayPrefs(wallet) {
  const key = prefsWalletKey(wallet);
  if (!key || !pool) return { supported: false, prefs: cleanDisplayPrefs({}) };
  try {
    const { rows } = await pool.query(`select prefs from public.wallet_display_prefs where wallet_key = $1 limit 1`, [key]);
    return { supported: true, prefs: cleanDisplayPrefs(rows[0]?.prefs || {}) };
  } catch (e) {
    if (e?.code === "42P01") return { supported: false, prefs: cleanDisplayPrefs({}) };
    throw e;
  }
}
