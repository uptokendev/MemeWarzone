import crypto from "crypto";
import { pool } from "../../server/db.js";
import { badMethod, getQuery, isAddress, isSolanaAddress, normalizeAddress, json } from "../../server/http.js";

function makeNonce() {
  return crypto.randomBytes(16).toString("hex");
}

function resolveNonceAddress(rawAddress, chainId) {
  const byChain = normalizeAddress(rawAddress, chainId);
  if (byChain) return byChain;
  // Cross-chain social: allow EVM address nonces even when a Solana draft chainId is sent.
  if (isAddress(rawAddress)) return String(rawAddress).toLowerCase();
  if (isSolanaAddress(rawAddress)) return String(rawAddress).trim();
  return "";
}

export default async function handler(req, res) {
  if (req.method !== "GET") return badMethod(res);

  try {
    const q = getQuery(req);
    const chainId = Number(q.chainId);
    const rawAddress = String(q.address ?? "").trim();
    if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });

    const address = resolveNonceAddress(rawAddress, chainId);
    if (!address) return json(res, 400, { error: "Invalid address" });
    if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });

    // No per-request DDL here. Two ALTER TABLE statements ran before every nonce and each takes an
    // ACCESS EXCLUSIVE lock on auth_nonces, so overlapping nonce requests (a boost fires several)
    // could deadlock or time out -> intermittent 500 (2026-09-25). Production already has
    // address text and no lowercase constraint (verified); chat/_lib.js keeps a one-time ensure.

    const nonce = makeNonce();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO auth_nonces (chain_id, address, nonce, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chain_id, address)
       DO UPDATE SET nonce = EXCLUDED.nonce, expires_at = EXCLUDED.expires_at, used_at = NULL`,
      [chainId, address, nonce, expiresAt]
    );

    return json(res, 200, { nonce, expiresAt: expiresAt.toISOString() });
  } catch (e) {
    console.error("[api/auth/nonce]", e);
    // Return the real error message in the response body so client logs / toasts show the actual cause
    // (e.g. "value too long for type character varying(42)", "relation \"auth_nonces\" does not exist", etc.).
    // This helps diagnose schema vs code issues without needing to tail Railway logs every time.
    return json(res, 500, {
      error: "Server error",
      message: String(e?.message || e),
    });
  }
}
