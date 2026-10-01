import crypto from "crypto";
import { ethers } from "ethers";
import { pool } from "../server/db.js";
import { badMethod, getQuery, isAddress, isSolanaAddress, isSolanaChain, normalizeAddress, json, readJson } from "../server/http.js";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function buildProfileMessage({ chainId, address, nonce, displayName, avatarUrl }) {
  const name = String(displayName ?? "").trim().slice(0, 32);
  const avatar = String(avatarUrl ?? "").trim().slice(0, 200);
  // address here is already normalized (raw base58 for Solana, lower 0x for EVM)
  // BannerUrl is NOT signed — same contract as bio — so existing wallets keep verifying.
  return [
    "MemeWarzone Profile",
    "Action: PROFILE_UPSERT",
    `ChainId: ${chainId}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    "",
    `DisplayName: ${name}`,
    `AvatarUrl: ${avatar}`,
  ].join("\n");
}

function base58Decode(value) {
  const raw = String(value || "").trim();
  if (!raw) return Buffer.alloc(0);
  let n = 0n;
  for (const char of raw) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) return Buffer.alloc(0);
    n = n * 58n + BigInt(index);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let out = hex === "00" ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let leadingZeros = 0;
  for (const char of raw) {
    if (char !== "1") break;
    leadingZeros += 1;
  }
  if (leadingZeros) out = Buffer.concat([Buffer.alloc(leadingZeros), out]);
  return out;
}

function verifySolanaSignature({ address, message, signature }) {
  try {
    const publicKeyBytes = base58Decode(address);
    if (publicKeyBytes.length !== 32) return false;
    const signatureBytes = Buffer.from(String(signature || ""), "base64");
    if (signatureBytes.length !== 64) return false;
    const keyObject = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message, "utf8"), keyObject, signatureBytes);
  } catch {
    return false;
  }
}

function verifyProfileSignature({ chainId, address, message, signature }) {
  try {
    if (isSolanaChain(chainId)) return verifySolanaSignature({ address, message, signature });
    const recovered = ethers.verifyMessage(message, signature).toLowerCase();
    return recovered === address.toLowerCase();
  } catch {
    return false;
  }
}

async function dropLegacyLowercaseAddressCheck() {
  await pool.query(`
    ALTER TABLE IF EXISTS public.user_profiles
      DROP CONSTRAINT IF EXISTS user_profiles_address_lowercase
  `);
}

async function upsertUserProfile(chainId, address, displayName, avatarUrl, bio, bannerUrl) {
  const withBanner = `
    INSERT INTO user_profiles (chain_id, address, display_name, avatar_url, bio, banner_url)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (chain_id, address)
    DO UPDATE SET
      display_name = EXCLUDED.display_name,
      avatar_url = EXCLUDED.avatar_url,
      bio = EXCLUDED.bio,
      banner_url = EXCLUDED.banner_url,
      updated_at = NOW()
  `;
  const withoutBanner = `
    INSERT INTO user_profiles (chain_id, address, display_name, avatar_url, bio)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (chain_id, address)
    DO UPDATE SET
      display_name = EXCLUDED.display_name,
      avatar_url = EXCLUDED.avatar_url,
      bio = EXCLUDED.bio,
      updated_at = NOW()
  `;
  const bannerParams = [chainId, address, displayName || null, avatarUrl, bio, bannerUrl];
  const legacyParams = [chainId, address, displayName || null, avatarUrl, bio];
  try {
    await pool.query(withBanner, bannerParams);
  } catch (e) {
    // Old BNB schema rejected mixed-case Solana pubkeys. Drop that check and retry once.
    if (e?.code === "23514" && /lower\s*\(/i.test(String(e?.message || ""))) {
      await dropLegacyLowercaseAddressCheck();
      try {
        await pool.query(withBanner, bannerParams);
        return;
      } catch (retryErr) {
        if (retryErr?.code === "42703") {
          await pool.query(withoutBanner, legacyParams);
          return;
        }
        throw retryErr;
      }
    }
    // banner_url migration not applied yet — keep username/avatar/bio saves working.
    if (e?.code === "42703") {
      await pool.query(withoutBanner, legacyParams);
      return;
    }
    throw e;
  }
}

function profileWriteError(e) {
  if (e?.code === "23505") {
    return { status: 409, error: "That callsign is already claimed on this chain." };
  }
  const msg = String(e?.message ?? "");
  if (/nonce|signature/i.test(msg)) return { status: 401, error: msg };
  return { status: 500, error: "Server error" };
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
    `UPDATE auth_nonces SET used_at = NOW() WHERE chain_id = $1 AND address = $2`,
    [chainId, address]
  );
}

async function loadRankState(chainId, address) {
  try {
    const { rows } = await pool.query(
      `SELECT current_rank AS rank,
              previous_rank AS "previousRank",
              rank_points AS "rankPoints",
              updated_at AS "rankUpdatedAt"
         FROM user_rank_state
        WHERE chain_id = $1 AND address = $2
        LIMIT 1`,
      [chainId, address]
    );
    return rows[0] ?? null;
  } catch (e) {
    const code = e?.code;
    if (code === "42P01" || code === "42703") return null;
    throw e;
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const q = getQuery(req);
      const chainId = Number(q.chainId);
      const raw = String(q.address ?? "").trim();
      const search = String(q.search ?? "").trim();
      if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });

      if (search && !raw) {
        if (search.length < 2) return json(res, 200, { items: [] });
        const limit = Math.min(Math.max(Number(q.limit || 8), 1), 20);
        const { rows } = await pool.query(
          `SELECT address,
                  chain_id AS "chainId",
                  display_name AS "displayName",
                  avatar_url AS "avatarUrl",
                  banner_url AS "bannerUrl",
                  bio
             FROM user_profiles
            WHERE chain_id = $1
              AND display_name IS NOT NULL
              AND btrim(display_name) <> ''
              AND display_name ILIKE $2
            ORDER BY
              CASE
                WHEN lower(display_name) = lower($3) THEN 0
                WHEN lower(display_name) LIKE lower($3) || '%' THEN 1
                ELSE 2
              END,
              updated_at DESC NULLS LAST
            LIMIT $4`,
          [chainId, `%${search}%`, search, limit],
        );
        return json(res, 200, { items: rows });
      }

      const isSol = isSolanaChain(chainId);
      const addr = normalizeAddress(raw, chainId);
      if (!addr) return json(res, 400, { error: "Invalid address" });
      if (isSol && !isSolanaAddress(addr)) return json(res, 400, { error: "Invalid address" });
      if (!isSol && !isAddress(addr)) return json(res, 400, { error: "Invalid address" });

      const { rows } = await pool.query(
        `SELECT address,
                chain_id AS "chainId",
                display_name AS "displayName",
                avatar_url AS "avatarUrl",
                banner_url AS "bannerUrl",
                bio,
                updated_at AS "updatedAt",
                created_at AS "createdAt"
           FROM user_profiles
          WHERE chain_id = $1 AND address = $2
          LIMIT 1`,
        [chainId, addr]
      );

      const profile = rows[0] ?? null;
      const rankState = await loadRankState(chainId, addr);

      return json(res, 200, {
        profile: profile ? { ...profile, ...(rankState ?? {}) } : rankState ? { chainId, address: addr, displayName: null, avatarUrl: null, bio: null, updatedAt: null, ...rankState } : null,
      });
    } catch (e) {
      // Common deployment footguns: missing table/columns after a new migration.
      // Don't break the whole frontend; return an empty profile and log the real error.
      const code = e?.code;
      console.error("[api/profile GET]", e);
      if (code === "42P01" || code === "42703") {
        return json(res, 200, { profile: null, warning: "DB schema missing profile tables/columns" });
      }
      return json(res, 500, { error: "Server error" });
    }
  }

  if (req.method === "POST") {
    try {
      const b = await readJson(req);
      const chainId = Number(b.chainId);
      const raw = String(b.address ?? "").trim();
      const displayName = String(b.displayName ?? "").trim().slice(0, 32);
      const avatarUrl = String(b.avatarUrl ?? "").trim().slice(0, 200) || null;
      const bannerUrl = String(b.bannerUrl ?? "").trim().slice(0, 200) || null;
      const bio = String(b.bio ?? "").trim().slice(0, 280) || null;
      const nonce = String(b.nonce ?? "");
      const signature = String(b.signature ?? "");

      if (!Number.isFinite(chainId)) return json(res, 400, { error: "Invalid chainId" });

      const isSol = isSolanaChain(chainId);
      const address = normalizeAddress(raw, chainId);
      if (!address) return json(res, 400, { error: "Invalid address" });
      if (isSol && !isSolanaAddress(address)) return json(res, 400, { error: "Invalid address" });
      if (!isSol && !isAddress(address)) return json(res, 400, { error: "Invalid address" });
      if (!nonce) return json(res, 400, { error: "Nonce missing" });
      if (!signature) return json(res, 400, { error: "Signature missing" });
      if (!pool) return json(res, 500, { error: "Server misconfigured: DATABASE_URL missing" });

      await consumeNonce(chainId, address, nonce);
      const msg = buildProfileMessage({ chainId, address, nonce, displayName, avatarUrl: avatarUrl ?? "" });
      if (!verifyProfileSignature({ chainId, address, message: msg, signature })) return json(res, 401, { error: "Invalid signature" });

      await upsertUserProfile(chainId, address, displayName, avatarUrl, bio, bannerUrl);

      return json(res, 200, { ok: true });
    } catch (e) {
      console.error("[api/profile POST]", e);
      const mapped = profileWriteError(e);
      return json(res, mapped.status, { error: mapped.error });
    }
  }

  return badMethod(res);
}
