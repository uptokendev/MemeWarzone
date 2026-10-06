import crypto from "node:crypto";
import { ethers } from "ethers";
import { isSolanaChain, normalizeAddress, normalizeWalletFlexible, json } from "../../server/http.js";
import { SESSION_DRAFT_ACTIONS, SESSION_SIGNATURE_PREFIX, sessionTokenFromSignature, sessionWalletForToken } from "../lib/sessionActions.js";

const ENGAGEMENT_ACTIONS = new Set([
  "follow_draft",
  "comment_draft",
  "arm_draft_notifications",
  "react_draft_comment",
]);

function resolveAuthWallet(value, chainId, action) {
  if (ENGAGEMENT_ACTIONS.has(action)) {
    return normalizeWalletFlexible(value) || normalizeAddress(value, chainId);
  }
  return normalizeAddress(value, chainId);
}

const ACTIONS = new Set([
  "create_draft",
  "read_draft",
  "save_promotion",
  "publish_promotion",
  "archive_draft",
  "deploy_draft",
  "manage_ticker_reservation",
  "follow_draft",
  "comment_draft",
  "arm_draft_notifications",
  "react_draft_comment",
  "draft_owner_session",
]);

const OWNER_SESSION_ACTION = "draft_owner_session";
const OWNER_SESSION_ACTIONS = new Set([
  "read_draft",
  "save_promotion",
  "publish_promotion",
  "archive_draft",
  "deploy_draft",
  "manage_ticker_reservation",
]);
const OWNER_SESSION_TTL_MS = 10 * 60 * 1000;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(Array.from(BASE58_ALPHABET).map((char, index) => [char, index]));

function buildDraftAuthMessage({ action, walletAddress, chainId, nonce, draftId }) {
  const walletLine =
    resolveAuthWallet(walletAddress, chainId, action) ||
    normalizeAddress(walletAddress, chainId) ||
    String(walletAddress || "").trim();
  const lines = [
    "MemeWarzone Prepare Mode",
    `Action: ${action}`,
    `Wallet: ${walletLine}`,
    `Chain ID: ${Number(chainId)}`,
  ];

  if (draftId) lines.push(`Draft ID: ${String(draftId)}`);
  lines.push(`Nonce: ${String(nonce || "")}`);

  return lines.join("\n");
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function decodeBase58(value) {
  const input = String(value || "");
  if (!input) return Buffer.alloc(0);

  let number = 0n;
  for (const char of input) {
    const digit = BASE58_INDEX.get(char);
    if (digit == null) throw new Error("Invalid base58 value");
    number = number * 58n + BigInt(digit);
  }

  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = number === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex");
  let leadingZeroes = 0;
  while (leadingZeroes < input.length && input[leadingZeroes] === "1") leadingZeroes += 1;
  return Buffer.concat([Buffer.alloc(leadingZeroes), body]);
}

function verifySolanaSignature(message, signature, walletAddress) {
  try {
    const publicKeyBytes = decodeBase58(walletAddress);
    const signatureBytes = Buffer.from(String(signature || ""), "base64");
    if (publicKeyBytes.length !== 32 || signatureBytes.length !== 64) return false;

    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: "der",
      type: "spki",
    });

    return crypto.verify(null, Buffer.from(message, "utf8"), publicKey, signatureBytes);
  } catch {
    return false;
  }
}

async function useExistingOwnerSession({ pool, credentialHash, draftId, chainId, wallet }) {
  const result = await pool.query(
    `update public.draft_owner_sessions
        set last_used_at = now()
      where token_hash = $1
        and draft_id = $2
        and chain_id = $3
        and wallet_address = $4
        and revoked_at is null
        and expires_at > now()
      returning expires_at`,
    [credentialHash, String(draftId), chainId, wallet],
  );
  return result.rows[0] || null;
}

async function consumeNonce({ pool, chainId, wallet, nonce }) {
  const result = await pool.query(
    `update public.auth_nonces
        set used_at = now()
      where chain_id = $1
        and address = $2
        and nonce = $3
        and used_at is null
        and expires_at > now()
      returning expires_at`,
    [chainId, wallet, nonce],
  );
  return result.rows[0] || null;
}

async function createOwnerSession({ pool, credentialHash, draftId, chainId, wallet, nonceExpiresAt }) {
  const nonceExpiryMs = new Date(nonceExpiresAt).getTime();
  const expiresAt = new Date(Math.min(Date.now() + OWNER_SESSION_TTL_MS, nonceExpiryMs));

  await pool.query(
    `insert into public.draft_owner_sessions
       (token_hash, draft_id, chain_id, wallet_address, expires_at, last_used_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (token_hash) do nothing`,
    [credentialHash, String(draftId), chainId, wallet, expiresAt],
  );

  return expiresAt.toISOString();
}

export async function requireDraftActionAuth({
  res,
  pool,
  auth,
  expectedWallet,
  chainId,
  action,
  draftId = null,
}) {
  if (!ACTIONS.has(action)) {
    json(res, 500, { error: "Invalid draft auth action." });
    return null;
  }

  if (!pool) {
    json(res, 503, { error: "Draft wallet auth requires DATABASE_URL-backed nonce storage." });
    return null;
  }

  const expectedChainId = Number(chainId);
  if (!Number.isFinite(expectedChainId) || expectedChainId <= 0) {
    json(res, 400, { error: "Invalid draft chain id." });
    return null;
  }

  const wallet = resolveAuthWallet(auth?.walletAddress || auth?.address || auth?.viewer, expectedChainId, action);
  const expected = resolveAuthWallet(expectedWallet, expectedChainId, action);
  if (!wallet || !expected || wallet !== expected) {
    json(res, 401, {
      error: ENGAGEMENT_ACTIONS.has(action)
        ? "Connected wallet does not match this request."
        : "Connected wallet does not match the draft owner.",
    });
    return null;
  }

  if (Number(auth?.chainId) !== expectedChainId) {
    json(res, 401, { error: "Connected wallet chain does not match this draft." });
    return null;
  }

  const credentialAction = String(auth?.action || "");
  const usingOwnerSession = credentialAction === OWNER_SESSION_ACTION;
  if (credentialAction !== action && !(usingOwnerSession && OWNER_SESSION_ACTIONS.has(action))) {
    json(res, 401, { error: "Wallet signature action does not match this request." });
    return null;
  }

  const expectedDraftId = draftId ? String(draftId) : null;
  const credentialDraftId = auth?.draftId ? String(auth.draftId) : null;
  if (expectedDraftId !== credentialDraftId) {
    json(res, 401, { error: "Wallet signature draft does not match this request." });
    return null;
  }

  // Follow, comment, like and alerts on a promotion page ride on the 30-day sign-in (founder, 2026-10-06).
  if (SESSION_DRAFT_ACTIONS.has(action) && String(auth?.signature || "").trim().startsWith(SESSION_SIGNATURE_PREFIX)) {
    let sessionWallet = "";
    try {
      sessionWallet = await sessionWalletForToken(pool, sessionTokenFromSignature(auth?.signature));
    } catch (error) {
      console.error("[draft-auth] session lookup failed", error?.message || error);
      json(res, 503, { error: "Sign-in check is unavailable.", code: "FEED_AUTH_UNAVAILABLE" });
      return null;
    }
    if (!sessionWallet) {
      json(res, 401, { error: "Your sign-in expired. Sign in with your wallet again.", code: "FEED_SESSION_REQUIRED" });
      return null;
    }
    if (resolveAuthWallet(sessionWallet, expectedChainId, action) !== wallet) {
      json(res, 401, { error: "Your sign-in is for a different wallet.", code: "WALLET_MISMATCH" });
      return null;
    }
    return { walletAddress: wallet, chainId: expectedChainId, session: true };
  }

  const nonce = String(auth?.nonce || "").trim();
  const signature = String(auth?.signature || "").trim();
  const message = String(auth?.message || "");
  if (!nonce || !signature) {
    json(res, 401, { error: "Wallet signature required." });
    return null;
  }

  const credentialHash = usingOwnerSession ? sha256Hex(signature) : null;
  if (usingOwnerSession) {
    if (!expectedDraftId) {
      json(res, 401, { error: "Draft owner sessions must be scoped to a draft." });
      return null;
    }
    const existingSession = await useExistingOwnerSession({
      pool,
      credentialHash,
      draftId: expectedDraftId,
      chainId: expectedChainId,
      wallet,
    });
    if (existingSession) {
      return {
        walletAddress: wallet,
        chainId: expectedChainId,
        ownerSession: true,
        sessionExpiresAt: existingSession.expires_at,
      };
    }
  }

  const expectedMessage = buildDraftAuthMessage({
    action: credentialAction,
    walletAddress: wallet,
    chainId: expectedChainId,
    nonce,
    draftId: expectedDraftId,
  });

  if (message !== expectedMessage) {
    json(res, 401, { error: "Wallet signature message mismatch." });
    return null;
  }

  let signatureValid = false;
  const looksEvm = /^0x[a-fA-F0-9]{40}$/.test(wallet);
  if (!looksEvm && (isSolanaChain(expectedChainId) || String(auth?.walletType || "").toLowerCase() === "solana")) {
    signatureValid = verifySolanaSignature(expectedMessage, signature, wallet);
  } else {
    try {
      const recovered = String(ethers.verifyMessage(expectedMessage, signature) || "").toLowerCase();
      signatureValid = recovered === wallet.toLowerCase();
    } catch {
      signatureValid = false;
    }
  }

  if (!signatureValid) {
    json(res, 401, { error: "Invalid wallet signature." });
    return null;
  }

  const consumed = await consumeNonce({ pool, chainId: expectedChainId, wallet, nonce });
  if (!consumed) {
    json(res, 401, { error: "Wallet auth nonce invalid, expired, or already used. Please sign again." });
    return null;
  }

  let sessionExpiresAt = null;
  if (usingOwnerSession) {
    sessionExpiresAt = await createOwnerSession({
      pool,
      credentialHash,
      draftId: expectedDraftId,
      chainId: expectedChainId,
      wallet,
      nonceExpiresAt: consumed.expires_at,
    });
  }

  return {
    walletAddress: wallet,
    chainId: expectedChainId,
    ownerSession: usingOwnerSession,
    sessionExpiresAt,
  };
}
