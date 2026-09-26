import crypto from "crypto";
import Ably from "ably";
import { ethers } from "ethers";
import { pool } from "../../server/db.js";
import { isAddress, isSolanaAddress, normalizeWalletFlexible } from "../../server/http.js";

function p(v) {
  return String(v ?? "").trim().replace(/^['"]|['"]$/g, "");
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function normalizeAddress(value) {
  return normalizeWalletFlexible(value);
}

function displayAddress(value) {
  const raw = String(value ?? "").trim();
  if (isSolanaAddress(raw)) return raw;
  return raw.toLowerCase();
}

function displayCampaign(value) {
  const raw = String(value ?? "").trim();
  if (isAddress(raw)) return raw.toLowerCase();
  return raw;
}

export function buildChatSessionMessage({ chainId, address, campaignAddress, nonce }) {
  return [
    "MemeWarzone War Room",
    "Action: CHAT_SESSION",
    `ChainId: ${chainId}`,
    `Address: ${displayAddress(address)}`,
    `Campaign: ${displayCampaign(campaignAddress)}`,
    `Nonce: ${nonce}`,
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
    const keyObject = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(message, "utf8"), keyObject, signatureBytes);
  } catch {
    return false;
  }
}

export function roomChannelName(chainId, campaignAddress) {
  const id = Number(chainId);
  const raw = String(campaignAddress || "").trim();
  const address = id === 101 || id === 102 ? raw : raw.toLowerCase();
  return `warroom:${id}:${address}`;
}

export function hashToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken)).digest("hex");
}

export function parseBearer(req) {
  const header = String(req.headers?.authorization ?? req.headers?.Authorization ?? "").trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

export function resolveAblyApiKey() {
  const raw = p(process.env.ABLY_API_KEY);

  const keyName = p(
    process.env.ABLY_API_KEY_NAME ||
    process.env.ABLY_KEY_NAME
  );

  const keySecret = p(
    process.env.ABLY_API_KEY_SECRET ||
    process.env.ABLY_KEY_SECRET ||
    process.env.ABLY_API_SECRET ||
    process.env.ABLY_SECRET
  );

  if (raw.includes(":")) return raw;
  if (raw && keySecret) return `${raw}:${keySecret}`;
  if (keyName && keySecret) return `${keyName}:${keySecret}`;

  const viteClientKey = p(process.env.VITE_ABLY_CLIENT_KEY);
  if (viteClientKey.includes(":")) return viteClientKey;

  return raw;
}

let authNonceSchemaReady = null;

// Runs once per process: ALTER TABLE takes an ACCESS EXCLUSIVE lock on auth_nonces, and running it
// on every chat join blocked concurrent /auth/nonce requests.
export function ensureAuthNonceSchema() {
  authNonceSchemaReady ??= applyAuthNonceSchema().catch((error) => {
    authNonceSchemaReady = null;
    throw error;
  });
  return authNonceSchemaReady;
}

async function applyAuthNonceSchema() {
  if (!pool) throw new Error("DATABASE_URL missing");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.auth_nonces (
      chain_id integer NOT NULL,
      address text NOT NULL,
      nonce text NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (chain_id, address)
    )
  `);

  await pool.query(`ALTER TABLE public.auth_nonces ADD COLUMN IF NOT EXISTS used_at timestamptz`);
  await pool.query(`ALTER TABLE public.auth_nonces ADD COLUMN IF NOT EXISTS expires_at timestamptz`);
  await pool.query(`ALTER TABLE public.auth_nonces ADD COLUMN IF NOT EXISTS nonce text`);
  await pool.query(`ALTER TABLE public.auth_nonces ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await pool.query(`ALTER TABLE public.auth_nonces ALTER COLUMN address TYPE text`);
  await pool.query(`ALTER TABLE public.auth_nonces DROP CONSTRAINT IF EXISTS auth_nonces_address_lowercase`);
}

export async function ensureChatSchema() {
  if (!pool) throw new Error("DATABASE_URL missing");
  try {
    await applyChatSchema();
  } catch (error) {
    // Production API roles cannot ALTER. The tables already exist; skip DDL.
    if (String(error?.code || "") === "42501") {
      console.warn("[api/chat] schema ensure skipped (no DDL privilege)");
      return;
    }
    throw error;
  }
}

async function applyChatSchema() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.chat_sessions (
      token_hash text PRIMARY KEY,
      chain_id integer NOT NULL,
      campaign_address text NOT NULL,
      wallet_address text NOT NULL,
      display_name text,
      avatar_url text,
      role text NOT NULL DEFAULT 'trader',
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`ALTER TABLE public.chat_sessions ADD COLUMN IF NOT EXISTS display_name text`);
  await pool.query(`ALTER TABLE public.chat_sessions ADD COLUMN IF NOT EXISTS avatar_url text`);
  await pool.query(`ALTER TABLE public.chat_sessions ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'trader'`);
  await pool.query(`ALTER TABLE public.chat_sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.chat_messages (
      id bigserial PRIMARY KEY,
      chain_id integer NOT NULL,
      campaign_address text NOT NULL,
      wallet_address text NOT NULL,
      display_name text,
      avatar_url text,
      role text NOT NULL DEFAULT 'trader',
      message text NOT NULL,
      client_nonce text,
      is_hidden boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS display_name text`);
  await pool.query(`ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS avatar_url text`);
  await pool.query(`ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'trader'`);
  await pool.query(`ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS client_nonce text`);
  await pool.query(`ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS is_hidden boolean NOT NULL DEFAULT false`);

await pool.query(`
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'chat_messages'
        AND column_name = 'hidden'
    ) THEN
      EXECUTE '
        UPDATE public.chat_messages
        SET is_hidden = COALESCE(hidden, false)
        WHERE is_hidden IS DISTINCT FROM COALESCE(hidden, false)
      ';
    END IF;
  END $$;
`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.chat_mutes (
      id bigserial PRIMARY KEY,
      chain_id integer NOT NULL,
      campaign_address text NOT NULL,
      wallet_address text NOT NULL,
      muted_until timestamptz NOT NULL,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_room_time ON public.chat_messages(chain_id, campaign_address, id DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_room_wallet ON public.chat_sessions(chain_id, campaign_address, wallet_address)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_mutes_room_wallet ON public.chat_mutes(chain_id, campaign_address, wallet_address)`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_chat_messages_room_wallet_nonce
    ON public.chat_messages(chain_id, campaign_address, wallet_address, client_nonce)
    WHERE client_nonce IS NOT NULL
  `);

  // Solana wallets and campaigns are case-sensitive base58. The BNB-era chat
  // schema enforced lowercase, so every Solana War Room join (chat_sessions)
  // and send (chat_messages) failed its INSERT with a CHECK violation and
  // surfaced as a 500. Dropped here the way auth/nonce.js drops its own, so
  // the fix ships with the API; db/migrations/20260921_000001 records it.
  await pool.query(`ALTER TABLE public.chat_sessions DROP CONSTRAINT IF EXISTS chat_sessions_wallet_lowercase`);
  await pool.query(`
    ALTER TABLE public.chat_messages
      DROP CONSTRAINT IF EXISTS chat_messages_campaign_lowercase,
      DROP CONSTRAINT IF EXISTS chat_messages_wallet_lowercase
  `);
}

export async function consumeNonce(chainId, address, nonce) {
  const normalized = normalizeAddress(address);
  if (!normalized) throw new Error("Invalid address");
  const { rows } = await pool.query(
    `SELECT nonce, expires_at, used_at
     FROM auth_nonces
     WHERE chain_id = $1 AND address = $2
     LIMIT 1`,
    [Number(chainId), normalized]
  );
  const row = rows[0];
  if (!row) throw new Error("Nonce not found");
  if (row.used_at) throw new Error("Nonce already used");
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (!exp || Date.now() > exp) throw new Error("Nonce expired");
  if (String(row.nonce) !== String(nonce)) throw new Error("Nonce mismatch");

  await pool.query(
    `UPDATE auth_nonces SET used_at = NOW(), updated_at = NOW() WHERE chain_id = $1 AND address = $2`,
    [Number(chainId), normalized]
  );
}

export async function fetchProfile(chainId, walletAddress) {
  try {
    const address = normalizeAddress(walletAddress);
    if (!address) return null;
    const { rows } = await pool.query(
      `SELECT display_name, avatar_url
       FROM public.user_profiles
       WHERE address = $2 AND (chain_id = $1 OR chain_id = 101)
       ORDER BY CASE WHEN chain_id = $1 THEN 0 ELSE 1 END
       LIMIT 1`,
      [Number(chainId), address]
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function createChatSession({ chainId, campaignAddress, walletAddress, displayName, avatarUrl, role = "trader" }) {
  const rawToken = crypto.randomBytes(24).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
  await pool.query(
    `DELETE FROM public.chat_sessions
     WHERE chain_id = $1 AND campaign_address = $2 AND wallet_address = $3`,
    [Number(chainId), normalizeAddress(campaignAddress), normalizeAddress(walletAddress)]
  );
  await pool.query(
    `INSERT INTO public.chat_sessions (
      token_hash, chain_id, campaign_address, wallet_address, display_name, avatar_url, role, expires_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
    [
      tokenHash,
      Number(chainId),
      // join.js, send.js and history.js all key the room by
      // normalizeAddress(campaign): Solana keeps its case, EVM lowercases.
      // Lowercasing here stored a room key nothing else ever looked up.
      normalizeAddress(campaignAddress),
      normalizeAddress(walletAddress),
      displayName || null,
      avatarUrl || null,
      role || "trader",
      expiresAt,
    ]
  );

  return { rawToken, expiresAt: expiresAt.toISOString() };
}

export async function loadSessionFromRequest(req, expectedChainId, expectedCampaignAddress) {
  const rawToken = parseBearer(req);
  if (!rawToken) throw new Error("Missing chat session");
  const tokenHash = hashToken(rawToken);
  const { rows } = await pool.query(
    `SELECT token_hash, chain_id, campaign_address, wallet_address, display_name, avatar_url, role, expires_at
     FROM public.chat_sessions
     WHERE token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );
  const row = rows[0];
  if (!row) throw new Error("Chat session not found");
  const exp = new Date(row.expires_at).getTime();
  if (!Number.isFinite(exp) || Date.now() > exp) {
    await pool.query(`DELETE FROM public.chat_sessions WHERE token_hash = $1`, [tokenHash]);
    throw new Error("Chat session expired");
  }
  if (Number(row.chain_id) !== Number(expectedChainId)) throw new Error("Chat session chain mismatch");
  if (String(row.campaign_address).toLowerCase() !== String(expectedCampaignAddress).toLowerCase()) {
    throw new Error("Chat session room mismatch");
  }
  return row;
}

export function sanitizeChatMessage(message) {
  const trimmed = String(message ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!trimmed) throw new Error("Message is empty");
  if (trimmed.length > 400) throw new Error("Message too long");
  return trimmed;
}

export async function ensureNotMuted({ chainId, campaignAddress, walletAddress }) {
  const { rows } = await pool.query(
    `SELECT muted_until
     FROM public.chat_mutes
     WHERE chain_id = $1 AND campaign_address = $2 AND wallet_address = $3
     ORDER BY muted_until DESC
     LIMIT 1`,
    [Number(chainId), normalizeAddress(campaignAddress), normalizeAddress(walletAddress)]
  );
  const until = rows[0]?.muted_until ? new Date(rows[0].muted_until).getTime() : 0;
  if (until && until > Date.now()) throw new Error("You are temporarily muted in this War Room");
}

export async function enforceRateLimit({ chainId, campaignAddress, walletAddress }) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM public.chat_messages
     WHERE chain_id = $1
       AND campaign_address = $2
       AND wallet_address = $3
       AND created_at > NOW() - INTERVAL '10 seconds'`,
    [Number(chainId), normalizeAddress(campaignAddress), normalizeAddress(walletAddress)]
  );
  const count = Number(rows[0]?.count ?? 0);
  if (count >= 5) throw new Error("Slow down a bit before sending another message");
}

export function mapMessageRow(row) {
  return {
    id: Number(row.id),
    chainId: Number(row.chain_id),
    campaignAddress: displayCampaign(row.campaign_address),
    walletAddress: displayAddress(row.wallet_address),
    displayName: row.display_name || null,
    avatarUrl: row.avatar_url || null,
    role: row.role || "trader",
    message: row.message,
    clientNonce: row.client_nonce || null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

export async function maybePublishChatMessage({ chainId, campaignAddress, message }) {
  const key = resolveAblyApiKey();
  if (!key || !key.includes(":")) return false;
  try {
    const ably = new Ably.Rest({ key });
    await ably.channels.get(roomChannelName(chainId, campaignAddress)).publish("message:new", message);
    return true;
  } catch (e) {
    console.warn("[api/chat] realtime publish skipped", e?.message || e);
    return false;
  }
}

export function verifyChatSessionSignature({ chainId, address, campaignAddress, nonce, signature }) {
  const msg = buildChatSessionMessage({ chainId, address, campaignAddress, nonce });
  if (isSolanaAddress(address)) {
    return verifySolanaSignature({ address, message: msg, signature }) ? address : "";
  }
  return ethers.verifyMessage(msg, signature).toLowerCase();
}
