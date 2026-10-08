import { pool } from "../../server/db.js";
import { badMethod, getQuery, isAddress, isSolanaAddress, isSolanaChain, json, normalizeAddress, readJson } from "../../server/http.js";
import { consumeNonce, verifyProfileSignature } from "../profile.js";
import { SESSION_SIGNATURE_PREFIX, sessionTokenFromSignature, sessionWalletForToken } from "../lib/sessionActions.js";
import { HANDLE_CHANGE_COOLDOWN_DAYS, handleProblem, missingHandlesTable, walletKey } from "../lib/userHandles.js";

/**
 * Usernames (founder, 2026-10-02).
 *   GET  ?wallet=W        -> { supported, handle, changedAt, nextChangeAt }
 *   GET  ?wallets=a,b,c   -> { supported, handles: { walletKey: handle } }  (up to 100; names instead of addresses)
 *   GET  ?check=name[&wallet=W] -> { supported, available, reason }   reason: format | reserved | taken | cooldown
 *   GET  ?q=prefix        -> { supported, items: [{ handle, wallet, displayName, avatarUrl }] }  (@ autocomplete)
 *   GET  ?handle=name     -> { supported, handle, wallet }  (profile links by username)
 *   POST { chainId, address, handle, nonce, signature } -> { ok, handle, changedAt }
 * Saving is signed like the profile (auth nonce + wallet signature). One username per wallet across
 * chains, unique case-insensitive, changeable once per 30 days.
 */
export function buildHandleMessage({ chainId, address, nonce, handle }) {
  return [
    "MemeWarzone Username",
    "Action: USERNAME_SET",
    `ChainId: ${chainId}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    "",
    `Username: ${handle}`,
  ].join("\n");
}

const COOLDOWN_MS = HANDLE_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

function nextChangeAt(changedAt) {
  const t = changedAt ? new Date(changedAt).getTime() : 0;
  return t ? new Date(t + COOLDOWN_MS).toISOString() : null;
}

async function rowForWallet(key) {
  const { rows } = await pool.query(
    `select handle, changed_at from public.user_handles where wallet_key = $1 limit 1`,
    [key],
  );
  return rows[0] || null;
}

async function handleGet(req, res) {
  const q = getQuery(req);
  try {
    if (q.wallets != null) {
      const keys = [...new Set(String(q.wallets || "").split(",").map(walletKey).filter(Boolean))].slice(0, 100);
      if (!keys.length) return json(res, 200, { supported: true, handles: {} });
      const { rows } = await pool.query(
        `select wallet_key, handle from public.user_handles where wallet_key = any($1::text[])`,
        [keys],
      );
      const handles = {};
      for (const r of rows) handles[r.wallet_key] = r.handle;
      return json(res, 200, { supported: true, handles });
    }
    if (q.wallet != null && q.check == null) {
      const key = walletKey(q.wallet);
      if (!key) return json(res, 400, { error: "Invalid wallet" });
      const row = await rowForWallet(key);
      return json(res, 200, {
        supported: true,
        handle: row?.handle || null,
        changedAt: row?.changed_at ? new Date(row.changed_at).toISOString() : null,
        nextChangeAt: row ? nextChangeAt(row.changed_at) : null,
      });
    }
    if (q.check != null) {
      const handle = String(q.check || "").trim();
      const problem = handleProblem(handle);
      if (problem) return json(res, 200, { supported: true, available: false, reason: problem });
      const { rows } = await pool.query(
        `select wallet_key from public.user_handles where lower(handle) = lower($1) limit 1`,
        [handle],
      );
      const key = walletKey(q.wallet);
      if (rows[0] && rows[0].wallet_key !== key) return json(res, 200, { supported: true, available: false, reason: "taken" });
      if (key && !rows[0]) {
        const own = await rowForWallet(key);
        if (own && Date.now() < new Date(own.changed_at).getTime() + COOLDOWN_MS) {
          return json(res, 200, { supported: true, available: false, reason: "cooldown", nextChangeAt: nextChangeAt(own.changed_at) });
        }
      }
      return json(res, 200, { supported: true, available: true, reason: null });
    }
    if (q.q != null) {
      const prefix = String(q.q || "").trim().replace(/^@/, "");
      if (!/^[A-Za-z0-9_]{1,20}$/.test(prefix)) return json(res, 200, { supported: true, items: [] });
      const { rows } = await pool.query(
        `select h.handle, h.wallet_key, up.display_name, up.avatar_url
           from public.user_handles h
           left join lateral (
             select display_name, avatar_url
               from public.user_profiles p
              where lower(p.address) = lower(h.wallet_key)
              order by (p.display_name is not null and length(btrim(p.display_name)) > 0) desc,
                       (p.avatar_url is not null and length(btrim(p.avatar_url)) > 0) desc,
                       p.updated_at desc nulls last
              limit 1
           ) up on true
          where lower(h.handle) like lower($1) || '%'
          order by length(h.handle), lower(h.handle)
          limit 8`,
        [prefix],
      );
      return json(res, 200, {
        supported: true,
        items: rows.map((r) => ({ handle: r.handle, wallet: r.wallet_key, displayName: r.display_name || null, avatarUrl: r.avatar_url || null })),
      });
    }
    if (q.handle != null) {
      const handle = String(q.handle || "").trim().replace(/^@/, "");
      if (!/^[A-Za-z0-9_]{1,20}$/.test(handle)) return json(res, 404, { supported: true, error: "Username not found" });
      const { rows } = await pool.query(
        `select handle, wallet_key from public.user_handles where lower(handle) = lower($1) limit 1`,
        [handle],
      );
      if (!rows[0]) return json(res, 404, { supported: true, error: "Username not found" });
      return json(res, 200, { supported: true, handle: rows[0].handle, wallet: rows[0].wallet_key });
    }
    return json(res, 400, { error: "Pass wallet, check, q or handle" });
  } catch (e) {
    if (missingHandlesTable(e)) return json(res, 200, { supported: false, handle: null, items: [], available: false, reason: "unsupported" });
    throw e;
  }
}

async function handlePost(req, res) {
  const b = req.body && typeof req.body === "object" && Object.keys(req.body).length ? req.body : await readJson(req);
  const chainId = Number(b.chainId);
  const raw = String(b.address ?? "").trim();
  const handle = String(b.handle ?? "").trim();
  const nonce = String(b.nonce ?? "");
  const signature = String(b.signature ?? "");

  if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
  const isSol = isSolanaChain(chainId);
  const address = normalizeAddress(raw, chainId);
  if (!address || (isSol ? !isSolanaAddress(address) : !isAddress(address))) return json(res, 400, { error: "Invalid address" });
  const problem = handleProblem(handle);
  if (problem === "format") return json(res, 400, { error: "Usernames are 3 to 20 characters: letters, numbers and _.", code: "HANDLE_FORMAT" });
  if (problem === "reserved") return json(res, 400, { error: "That username is reserved.", code: "HANDLE_RESERVED" });
  if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });

  // The 30-day sign-in in place of a signature (founder, 2026-10-06), sent as `session:<token>`.
  if (signature.startsWith(SESSION_SIGNATURE_PREFIX)) {
    let sessionWallet = "";
    try {
      sessionWallet = await sessionWalletForToken(pool, sessionTokenFromSignature(signature));
    } catch (e) {
      console.error("[api/profile/handle] session lookup failed", e?.message || e);
      return json(res, 503, { error: "Sign-in check is unavailable.", code: "FEED_AUTH_UNAVAILABLE" });
    }
    if (!sessionWallet) return json(res, 401, { error: "Your sign-in expired. Sign in with your wallet again.", code: "FEED_SESSION_REQUIRED" });
    if (normalizeAddress(sessionWallet, chainId) !== address) return json(res, 401, { error: "Your sign-in is for a different wallet.", code: "WALLET_MISMATCH" });
  } else {
    if (!nonce) return json(res, 400, { error: "Nonce missing" });
    if (!signature) return json(res, 400, { error: "Signature missing" });
    try {
      await consumeNonce(chainId, address, nonce);
    } catch (e) {
      return json(res, 401, { error: String(e?.message || "Nonce error") });
    }
    const msg = buildHandleMessage({ chainId, address, nonce, handle });
    if (!verifyProfileSignature({ chainId, address, message: msg, signature })) return json(res, 401, { error: "Invalid signature" });
  }

  const key = walletKey(address);
  try {
    // One statement: insert, or update when the name only changes case or the cooldown has passed.
    // No row back = still in the cooldown. A unique violation = someone else holds the name.
    const { rows } = await pool.query(
      `insert into public.user_handles as h (wallet_key, handle)
       values ($1, $2)
       on conflict (wallet_key) do update
          set handle = excluded.handle,
              changed_at = case when lower(h.handle) = lower(excluded.handle) then h.changed_at else now() end
        where lower(h.handle) = lower(excluded.handle)
           or h.changed_at <= now() - make_interval(days => $3::int)
       returning handle, changed_at`,
      [key, handle, HANDLE_CHANGE_COOLDOWN_DAYS],
    );
    if (!rows[0]) {
      const own = await rowForWallet(key);
      return json(res, 429, {
        error: `You can change your username once every ${HANDLE_CHANGE_COOLDOWN_DAYS} days.`,
        code: "HANDLE_COOLDOWN",
        nextChangeAt: own ? nextChangeAt(own.changed_at) : null,
      });
    }
    return json(res, 200, { ok: true, handle: rows[0].handle, changedAt: new Date(rows[0].changed_at).toISOString() });
  } catch (e) {
    if (e?.code === "23505") return json(res, 409, { error: "That username is taken.", code: "HANDLE_TAKEN" });
    if (missingHandlesTable(e)) return json(res, 503, { error: "Usernames are not available yet.", code: "HANDLES_UNAVAILABLE" });
    throw e;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "POST") return await handlePost(req, res);
    return badMethod(res);
  } catch (e) {
    console.error("[api/profile/handle]", e);
    return json(res, 500, { error: "Server error" });
  }
}
