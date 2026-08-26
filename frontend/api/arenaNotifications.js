import { randomBytes } from "crypto";

import { pool } from "../server/db.js";
import { badMethod, getQuery, json, normalizeWalletFlexible, readJson } from "../server/http.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import { sendVerifyEmail } from "./lib/arenaNotify.js";

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function walletKey(value) {
  return normalizeWalletFlexible(value) || String(value || "").trim();
}

async function findByWallet(wallet) {
  const key = walletKey(wallet);
  if (!key) return null;
  const result = await pool.query(
    `select wallet, email, verified_at, created_at, updated_at
       from public.wallet_notification_emails
      where lower(wallet) = lower($1)
      limit 1`,
    [key],
  );
  return result.rows[0] || null;
}

function publicRow(row) {
  if (!row) return { configured: false, verified: false, email: null };
  return {
    configured: true,
    verified: Boolean(row.verified_at),
    email: String(row.email),
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
  };
}

async function requireWallet(req, res, action, extraLines = []) {
  const body = await readJson(req);
  const wallet = walletKey(body.walletAddress || body.auth?.walletAddress || body.wallet || "");
  const chainId = Number(body.chainId || body.auth?.chainId || 56);
  if (!wallet) {
    json(res, 400, { ok: false, error: "walletAddress is required" });
    return null;
  }
  const verified = await requireWalletActionAuth({
    res,
    pool,
    auth: body.auth || body,
    expectedWallet: wallet,
    chainId,
    action,
    routeLabel: "arena/notifications/email",
    extraLines,
  });
  if (!verified) return null;
  return { body, wallet, chainId };
}

async function handleStatus(req, res) {
  const ctx = await requireWallet(req, res, "arena_notification_email_status");
  if (!ctx) return;
  return json(res, 200, { ok: true, ...publicRow(await findByWallet(ctx.wallet)) });
}

async function handleSet(req, res) {
  const ctx = await requireWallet(req, res, "arena_notification_email_set");
  if (!ctx) return;
  const email = String(ctx.body.email || "").trim().toLowerCase();
  if (!isEmail(email)) return json(res, 400, { ok: false, error: "A valid email is required" });
  const token = randomBytes(24).toString("hex");
  await pool.query(
    `insert into public.wallet_notification_emails (wallet, email, verified_at, verify_token)
     values ($1,$2,null,$3)
     on conflict (wallet) do update set
       email = excluded.email,
       verified_at = null,
       verify_token = excluded.verify_token,
       updated_at = now()`,
    [ctx.wallet, email, token],
  );
  let mailed = { ok: true, skipped: true, reason: "not_attempted" };
  try {
    mailed = await sendVerifyEmail({ email, token, wallet: ctx.wallet });
  } catch (error) {
    console.warn("[arenaNotifications] verify email failed", error?.message || error);
    mailed = { ok: false, skipped: false, error: String(error?.message || error) };
  }
  return json(res, 200, {
    ok: true,
    ...publicRow(await findByWallet(ctx.wallet)),
    verifyEmailSent: Boolean(mailed?.ok && !mailed?.skipped),
    verifyEmailSkipped: Boolean(mailed?.skipped),
  });
}

async function handleVerify(req, res) {
  const query = getQuery(req);
  const token = String(query.token || "").trim();
  if (!token) return json(res, 400, { ok: false, error: "token is required" });
  const result = await pool.query(
    `update public.wallet_notification_emails
        set verified_at = now(), verify_token = null, updated_at = now()
      where verify_token = $1
      returning wallet, email, verified_at`,
    [token],
  );
  if (!result.rows[0]) return json(res, 404, { ok: false, error: "Invalid or expired verification token" });
  return json(res, 200, { ok: true, ...publicRow(result.rows[0]) });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  try {
    if (method === "GET" && /\/arena\/notifications\/email\/verify$/.test(path)) return handleVerify(req, res);
    if (method === "POST" && /\/arena\/notifications\/email\/status$/.test(path)) return handleStatus(req, res);
    if (method === "POST" && /\/arena\/notifications\/email$/.test(path)) return handleSet(req, res);
    if (path.includes("/arena/notifications")) return badMethod(res);
    return json(res, 404, { error: `Unknown arena notifications route: ${path}` });
  } catch (error) {
    console.error("[api/arenaNotifications]", error);
    return json(res, 503, { ok: false, error: "Notification storage is unavailable", detail: String(error?.message || error) });
  }
}
