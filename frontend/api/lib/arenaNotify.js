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
  const subject = `Warzone challenge: ${challengerSymbol || "A coin"} challenged ${defenderSymbol || "your coin"}`;
  const text = [
    "You have an incoming Warzone challenge.",
    "",
    `${challengerSymbol || "A rival"} challenged ${defenderSymbol || "your coin"}.`,
    "Accept, decline, or counter-offer a different stake in Command Center Battles. Unanswered challenges expire in 24 hours.",
    "",
    `Command Center: ${battlesUrl}`,
    `Battle: ${battleUrl}`,
    "",
    "MemeWarzone",
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
  const url = `${origin}/warzone/verify-email?token=${encodeURIComponent(token)}`;
  const subject = "Verify your MemeWarzone Warzone email";
  const text = [
    "Confirm this address to receive Warzone challenge emails.",
    "",
    `Verify: ${url}`,
    "",
    `Wallet: ${walletKey(wallet)}`,
    "",
    "If you did not request this, ignore the message.",
  ].join("\n");
  return sendEmailNotification({ to: email, subject, text });
}

export async function notifyCounterOffer({ toWallet, fromSymbol, toSymbol, amount, nativeSymbol, previousAmount, durationHours, previousDurationHours, battleId }) {
  const to = await verifiedEmailForWallet(toWallet);
  if (!to) return { ok: true, skipped: true, reason: "no_verified_email" };
  const origin = siteOrigin();
  const walletPath = walletKey(toWallet);
  const battlesUrl = `${origin}/profile/${encodeURIComponent(walletPath)}/command/battles`;
  const battleUrl = `${origin}/battle/${encodeURIComponent(battleId)}`;
  const unit = nativeSymbol || "BNB";
  const subject = `Warzone counter-offer: ${fromSymbol || "A rival"} offered ${amount} ${unit}`;
  const text = [
    "A counter-offer was made on your Warzone challenge.",
    "",
    `${fromSymbol || "A rival"} offered ${amount} ${unit} / ${Number(durationHours) === 72 ? "3 days" : Number(durationHours) === 168 ? "7 days" : "24 hours"} instead of ${previousAmount} ${unit} / ${Number(previousDurationHours) === 72 ? "3 days" : Number(previousDurationHours) === 168 ? "7 days" : "24 hours"} for ${toSymbol || "your coin"}.`,
    "Accept, decline, or counter again in Command Center Battles. Unanswered offers expire in 24 hours.",
    "",
    `Command Center: ${battlesUrl}`,
    `Battle: ${battleUrl}`,
    "",
    "MemeWarzone",
  ].join("\n");
  try {
    return await sendEmailNotification({ to, subject, text });
  } catch (error) {
    console.warn("[arenaNotify] counter-offer email failed", error?.message || error);
    return { ok: false, skipped: false, error: String(error?.message || error) };
  }
}
