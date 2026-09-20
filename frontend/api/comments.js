import { ethers } from "ethers";
import { pool } from "../server/db.js";
import { badMethod, getQuery, isAddress, isSolanaAddress, isSolanaChain, json, readJson } from "../server/http.js";
import { buildCommentMessage, canonCampaign, canonWallet } from "./lib/commentsCanon.js";
import { verifySolanaSignature } from "./lib/walletActionAuth.js";

// Solana campaigns and wallets are case-sensitive base58. The BNB-era schema
// (002_social.sql) enforced lowercase on token_comments, so every Solana
// comment passed nonce and signature checks and then failed its INSERT with a
// CHECK violation, surfacing as a 500. Dropped here once per process the way
// auth/nonce.js drops auth_nonces_address_lowercase, so the fix ships with the
// API; db/migrations/20260921_000001 records it.
let commentsSchemaReady = null;
function ensureCommentsSchema() {
  if (!commentsSchemaReady) {
    commentsSchemaReady = pool
      .query(
        `ALTER TABLE IF EXISTS public.token_comments
           DROP CONSTRAINT IF EXISTS token_comments_campaign_lowercase,
           DROP CONSTRAINT IF EXISTS token_comments_author_lowercase,
           DROP CONSTRAINT IF EXISTS token_comments_token_lowercase`,
      )
      .catch((e) => {
        commentsSchemaReady = null;
        throw e;
      });
  }
  return commentsSchemaReady;
}

async function consumeNonce(chainId, address, nonce) {
  const { rows } = await pool.query(
    `SELECT nonce, expires_at, used_at
     FROM auth_nonces
     WHERE chain_id = $1 AND address = $2
     LIMIT 1`,
    [chainId, address]
  );
  const row = rows[0];
  if (!row) throw new Error("Nonce not found");
  if (row.used_at) throw new Error("Nonce already used");
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (!exp || Date.now() > exp) throw new Error("Nonce expired");
  if (String(row.nonce) !== String(nonce)) throw new Error("Nonce mismatch");

  await pool.query(
    `UPDATE auth_nonces
     SET used_at = NOW()
     WHERE chain_id = $1 AND address = $2`,
    [chainId, address]
  );
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const q = getQuery(req);
      const chainId = Number(q.chainId);
      const campaignAddress = canonCampaign(chainId, q.campaignAddress);
      const limitRaw = Number(q.limit ?? 50);
      const beforeIdRaw = q.beforeId != null ? Number(q.beforeId) : null;

      if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
      if (!campaignAddress) return json(res, 400, { error: "Invalid campaignAddress" });
      const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));
      const beforeId = beforeIdRaw != null && Number.isFinite(beforeIdRaw) ? beforeIdRaw : null;

      const { rows } = await pool.query(
        `SELECT
           c.id,
           c.body,
           c.author_address AS "authorAddress",
           c.parent_id AS "parentId",
           c.created_at AS "createdAt",
           p.display_name AS "authorDisplayName",
           p.avatar_url AS "authorAvatarUrl"
         FROM token_comments c
         LEFT JOIN user_profiles p
           ON p.chain_id = c.chain_id AND p.address = c.author_address
         WHERE c.chain_id = $1
           AND c.campaign_address = $2
           AND c.status = 0
           AND ($3::bigint IS NULL OR c.id < $3)
         ORDER BY c.id DESC
         LIMIT $4`,
        [chainId, campaignAddress, beforeId, limit]
      );

      return json(res, 200, { items: rows });
    } catch (e) {
      const code = e?.code;
      console.error("[api/comments GET]", e);
      if (code === "42P01" || code === "42703") {
        return json(res, 200, { items: [], warning: "DB schema missing comments/profile tables/columns" });
      }
      return json(res, 500, { error: "Server error" });
    }
  }

  if (req.method === "POST") {
    try {
      const b = await readJson(req);
      const chainId = Number(b.chainId);
      const campaignAddress = canonCampaign(chainId, b.campaignAddress);
      const rawToken = b.tokenAddress ? String(b.tokenAddress).trim() : "";
      const tokenAddress = rawToken
        ? (isSolanaChain(chainId) ? (isSolanaAddress(rawToken) ? rawToken : "") : (isAddress(rawToken.toLowerCase()) ? rawToken.toLowerCase() : ""))
        : null;
      const address = canonWallet(chainId, b.address);
      const body = String(b.body ?? "");
      const nonce = String(b.nonce ?? "");
      const signature = String(b.signature ?? "");
      const parentId = b.parentId != null ? Number(b.parentId) : null;

      if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });
      if (!campaignAddress) return json(res, 400, { error: "Invalid campaignAddress" });
      if (!address) return json(res, 400, { error: "Invalid address" });
      if (rawToken && !tokenAddress) return json(res, 400, { error: "Invalid tokenAddress" });

      const trimmed = body.trim();
      if (!trimmed) return json(res, 400, { error: "Comment is empty" });
      if (trimmed.length > 500) return json(res, 400, { error: "Comment too long" });
      if (!nonce) return json(res, 400, { error: "Nonce missing" });
      if (!signature) return json(res, 400, { error: "Signature missing" });

      await ensureCommentsSchema();
      await consumeNonce(chainId, address, nonce);

      const msg = buildCommentMessage({ chainId, address, campaignAddress, nonce, body: trimmed });
      const solana = isSolanaChain(chainId) || isSolanaAddress(address);
      if (solana) {
        if (!verifySolanaSignature(msg, signature, address)) return json(res, 401, { error: "Invalid signature" });
      } else {
        const recovered = ethers.verifyMessage(msg, signature).toLowerCase();
        if (recovered !== address) return json(res, 401, { error: "Invalid signature" });
      }

      const { rows } = await pool.query(
        `INSERT INTO token_comments (
           chain_id, campaign_address, token_address, author_address, body, parent_id, status
         ) VALUES ($1, $2, $3, $4, $5, $6, 0)
         RETURNING id`,
        [chainId, campaignAddress, tokenAddress, address, trimmed, parentId]
      );

      return json(res, 200, { id: rows[0]?.id ?? null });
    } catch (e) {
      const msg = String(e?.message ?? "");
      const isAuth = /nonce|signature/i.test(msg);
      console.error("[api/comments POST]", e);
      return json(res, isAuth ? 401 : 500, { error: isAuth ? msg : "Server error" });
    }
  }

  return badMethod(res);
}
