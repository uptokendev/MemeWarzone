import { pool } from "../../server/db.js";
import { notificationAllowed } from "./notificationPrefs.js";
import { normalizeWalletFlexible } from "../../server/http.js";
import { sendEmailNotification, siteOrigin } from "./notify.js";
import { notifyWallet, unsubscribeUrl } from "./walletNotify.js";

/** CO-5: every battle email ends with a link that stops battle emails only. */
function battleStopLine(wallet) {
  const url = unsubscribeUrl(wallet, "battles");
  return url ? `Stop battle emails: ${url}` : null;
}

function battlePath(battleId) {
  return `/battle/${encodeURIComponent(battleId)}`;
}

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
  await notifyWallet(pool, {
    wallet: defenderWallet,
    category: "battles",
    kind: "challenge",
    targetType: "battle",
    targetId: String(battleId || ""),
    dedupeKey: battleId ? `battle:${battleId}:challenge` : null,
    title: `${challengerSymbol || "A coin"} challenged ${defenderSymbol || "your coin"}`,
    body: "Accept, decline or counter in Command Center Battles. Unanswered challenges expire in 24 hours.",
    target: `/profile/${encodeURIComponent(walletKey(defenderWallet))}/command/battles`,
  });
  const to = await verifiedEmailForWallet(defenderWallet);
  // CO-5: the wallet can turn battle emails off (default on).
  if (to && !(await notificationAllowed(defenderWallet, "battles", "email"))) return { ok: true, skipped: true, reason: "email_off" };
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
    battleStopLine(defenderWallet),
  ].filter((line) => line !== null).join("\n");
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

export async function notifyDeclined({ toWallet, fromSymbol, toSymbol, battleId, message }) {
  await notifyWallet(pool, {
    wallet: toWallet,
    category: "battles",
    kind: "declined",
    targetType: "battle",
    targetId: String(battleId || ""),
    dedupeKey: battleId ? `battle:${battleId}:declined` : null,
    title: `${fromSymbol || "A rival"} declined your challenge`,
    body: String(message || "").trim() ? `Message: ${String(message).trim().slice(0, 300)}` : "No message was included.",
    target: battlePath(battleId),
  });
  const to = await verifiedEmailForWallet(toWallet);
  // CO-5: the wallet can turn battle emails off (default on).
  if (to && !(await notificationAllowed(toWallet, "battles", "email"))) return { ok: true, skipped: true, reason: "email_off" };
  if (!to) return { ok: true, skipped: true, reason: "no_verified_email" };
  const origin = siteOrigin();
  const walletPath = walletKey(toWallet);
  const battlesUrl = `${origin}/profile/${encodeURIComponent(walletPath)}/command/battles`;
  const battleUrl = `${origin}/battle/${encodeURIComponent(battleId)}`;
  const note = String(message || "").trim();
  const subject = `Warzone challenge declined: ${fromSymbol || "A rival"} declined ${toSymbol || "the challenge"}`;
  const text = [
    "A Warzone challenge was declined.",
    "",
    `${fromSymbol || "A rival"} declined the challenge against ${toSymbol || "your coin"}.`,
    note ? `Message: ${note}` : "No message was included.",
    "",
    `Command Center: ${battlesUrl}`,
    `Battle: ${battleUrl}`,
    "",
    "MemeWarzone",
    battleStopLine(toWallet),
  ].filter((line) => line !== null).join("\n");
  try {
    return await sendEmailNotification({ to, subject, text });
  } catch (error) {
    console.warn("[arenaNotify] decline email failed", error?.message || error);
    return { ok: false, skipped: false, error: String(error?.message || error) };
  }
}

export async function notifyCounterOffer({ toWallet, fromSymbol, toSymbol, amount, nativeSymbol, previousAmount, durationHours, previousDurationHours, battleId }) {
  await notifyWallet(pool, {
    wallet: toWallet,
    category: "battles",
    kind: "counter",
    targetType: "battle",
    targetId: String(battleId || ""),
    dedupeKey: battleId ? `battle:${battleId}:counter:${amount}:${durationHours}:${previousAmount}:${previousDurationHours}` : null,
    title: `${fromSymbol || "A rival"} made a counter-offer`,
    body: `${amount} ${nativeSymbol || "BNB"} for ${toSymbol || "your coin"}. Accept, decline or counter in Command Center Battles.`,
    target: `/profile/${encodeURIComponent(walletKey(toWallet))}/command/battles`,
  });
  const to = await verifiedEmailForWallet(toWallet);
  // CO-5: the wallet can turn battle emails off (default on).
  if (to && !(await notificationAllowed(toWallet, "battles", "email"))) return { ok: true, skipped: true, reason: "email_off" };
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
    battleStopLine(toWallet),
  ].filter((line) => line !== null).join("\n");
  try {
    return await sendEmailNotification({ to, subject, text });
  } catch (error) {
    console.warn("[arenaNotify] counter-offer email failed", error?.message || error);
    return { ok: false, skipped: false, error: String(error?.message || error) };
  }
}

/** CO-5: the side that made the last offer is told when it is accepted (bell + email). */
export async function notifyAccepted({ toWallet, fromSymbol, toSymbol, battleId, escrowRequired }) {
  await notifyWallet(pool, {
    wallet: toWallet,
    category: "battles",
    kind: "accepted",
    targetType: "battle",
    targetId: String(battleId || ""),
    dedupeKey: battleId ? `battle:${battleId}:accepted` : null,
    title: `${fromSymbol || "A rival"} accepted your challenge`,
    body: escrowRequired
      ? `The battle with ${toSymbol || "your coin"} is agreed. Put in your stake to start it.`
      : `The battle with ${toSymbol || "your coin"} has started.`,
    target: battlePath(battleId),
  });
  const to = await verifiedEmailForWallet(toWallet);
  if (to && !(await notificationAllowed(toWallet, "battles", "email"))) return { ok: true, skipped: true, reason: "email_off" };
  if (!to) return { ok: true, skipped: true, reason: "no_verified_email" };
  const origin = siteOrigin();
  const subject = `Warzone challenge accepted: ${fromSymbol || "A rival"} accepted`;
  const text = [
    `${fromSymbol || "A rival"} accepted the challenge against ${toSymbol || "your coin"}.`,
    escrowRequired ? "Put in your stake to start the battle." : "The battle has started.",
    "",
    `Battle: ${origin}${battlePath(battleId)}`,
    "",
    "MemeWarzone",
    battleStopLine(toWallet),
  ].filter((line) => line !== null).join("\n");
  try {
    return await sendEmailNotification({ to, subject, text });
  } catch (error) {
    console.warn("[arenaNotify] accepted email failed", error?.message || error);
    return { ok: false, skipped: false, error: String(error?.message || error) };
  }
}
