import { pool } from "../../server/db.js";
import { normalizeWalletFlexible } from "../../server/http.js";
import { sendEmailNotification, siteOrigin } from "./notify.js";

function walletKey(value) {
  return normalizeWalletFlexible(value) || String(value || "").trim().toLowerCase();
}

export async function verifiedEmailForWallet(wallet) {
  const key = walletKey(wallet);
  if (!key) return null;
  const result = await pool.query(
    `select email from public.wallet_notification_emails
      where lower(wallet) = lower($1) and verified_at is not null
      limit 1`,
    [key],
  );
  return result.rows[0]?.email || null;
}

export async function notifyChallenge({ defenderWallet, challengerSymbol, defenderSymbol, battleId }) {
  const to = await verifiedEmailForWallet(defenderWallet);
  if (!to) return { ok: true, skipped: true, reason: "no_verified_email" };
  const origin = siteOrigin();
  const walletPath = walletKey(defenderWallet);
  const battlesUrl = `${origin}/profile/${encodeURIComponent(walletPath)}/command/battles`;
  const battleUrl = `${origin}/battle/${encodeURIComponent(battleId)}`;
  const subject = `Arena challenge: ${challengerSymbol || "A coin"} challenged ${defenderSymbol || "your coin"}`;
  const text = [
    "You have an incoming Arena challenge.",
    "",
    `${challengerSymbol || "A rival"} challenged ${defenderSymbol || "your coin"}.`,
    "Accept or decline in Command Center Battles. Unanswered challenges expire in 24 hours.",
    "",
    `Command Center: ${battlesUrl}`,
    `Battle: ${battleUrl}`,
    "",
    "MemeWarzone Arena",
  ].join("\n");
  try {
    return await sendEmailNotification({ to, subject, text });
  } catch (error) {
    console.warn("[arenaNotify] challenge email failed", error?.message || error);
    return { ok: false, skipped: false, error: String(error?.message || error) };
  }
}

export async function sendVerifyEmail({ email, token, wallet }) {
  const origin = siteOrigin();
  const url = `${origin}/arena/verify-email?token=${encodeURIComponent(token)}`;
  const subject = "Verify your MemeWarzone Arena email";
  const text = [
    "Confirm this address to receive Arena challenge emails.",
    "",
    `Verify: ${url}`,
    "",
    `Wallet: ${walletKey(wallet)}`,
    "",
    "If you did not request this, ignore the message.",
  ].join("\n");
  return sendEmailNotification({ to: email, subject, text });
}
