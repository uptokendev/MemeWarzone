/**
 * Generic wallet action auth (nonce + signature), shared across claims/follows/upload.
 * Message brand: MemeWarzone API Action
 * Dual-auth: when API_AUTH_ENFORCE_USER_WRITES is off, missing auth is allowed with a warning.
 * Callers that can never use the legacy-open path may pass strict=true.
 */

import crypto from "node:crypto";
import { ethers } from "ethers";
import { isSolanaChain, normalizeAddress, json } from "../../server/http.js";
import { isAuthEnforceUserWrites } from "./apiAuth.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(Array.from(BASE58_ALPHABET).map((char, index) => [char, index]));

export function buildWalletActionMessage({ action, walletAddress, chainId, nonce, extraLines = [] }) {
  const lines = [
    "MemeWarzone API Action",
    `Action: ${action}`,
    `Wallet: ${normalizeAddress(walletAddress, chainId)}`,
    `Chain ID: ${Number(chainId)}`,
  ];
  for (const line of extraLines) {
    if (line) lines.push(String(line));
  }
  lines.push(`Nonce: ${String(nonce || "")}`);
  return lines.join("\n");
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

export function verifySolanaSignature(message, signature, walletAddress) {
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

/**
 * @param {object} opts
 * @param {import('express').Response} opts.res
 * @param {import('pg').Pool} opts.pool
 * @param {object} opts.auth - { action, walletAddress|address, chainId, nonce, message, signature, walletType? }
 * @param {string} opts.expectedWallet
 * @param {number} opts.chainId
 * @param {string} opts.action
 * @param {string[]} [opts.extraLines]
 * @param {boolean} [opts.strict] - force nonce/signature enforcement regardless of the global legacy-open flag
 * @returns {Promise<{ walletAddress: string, chainId: number, legacy?: boolean }|null>}
 */
export async function requireWalletActionAuth({
  res,
  pool,
  auth,
  expectedWallet,
  chainId,
  action,
  extraLines = [],
  routeLabel = action,
  strict = false,
}) {
  const enforce = Boolean(strict) || isAuthEnforceUserWrites();
  const expectedChainId = Number(chainId);
  // Allow 0 for EVM social-graph follows (wallet-global, not per 56/97).
  if (!Number.isFinite(expectedChainId) || expectedChainId < 0) {
    json(res, 400, { error: "Invalid chain id.", code: "INVALID_CHAIN" });
    return null;
  }

  const wallet = normalizeAddress(auth?.walletAddress || auth?.address || expectedWallet, expectedChainId);
  const expected = normalizeAddress(expectedWallet, expectedChainId);

  if (!wallet || !expected) {
    if (!enforce) {
      console.warn(`[walletActionAuth] ${routeLabel}: missing wallet; legacy open`);
      return { walletAddress: expected || wallet || "", chainId: expectedChainId, legacy: true };
    }
    json(res, 401, { error: "Wallet required.", code: "WALLET_REQUIRED" });
    return null;
  }

  if (wallet !== expected) {
    json(res, 401, { error: "Connected wallet does not match request.", code: "WALLET_MISMATCH" });
    return null;
  }

  const hasSig = Boolean(String(auth?.signature || "").trim() && String(auth?.nonce || "").trim());
  if (!hasSig) {
    if (!enforce) {
      console.warn(`[walletActionAuth] ${routeLabel}: no signature; legacy open for ${wallet}`);
      return { walletAddress: wallet, chainId: expectedChainId, legacy: true };
    }
    json(res, 401, { error: "Wallet signature required.", code: "SIGNATURE_REQUIRED" });
    return null;
  }

  const rejectOrLegacy = (code, error) => {
    if (!enforce) {
      console.warn(`[walletActionAuth] ${routeLabel}: ${code}; legacy open for ${wallet}`);
      return { walletAddress: wallet, chainId: expectedChainId, legacy: true };
    }
    json(res, 401, { error, code });
    return null;
  };

  try {
    if (!pool) {
      if (!enforce) {
        console.warn(`[walletActionAuth] ${routeLabel}: no pool; legacy open for ${wallet}`);
        return { walletAddress: wallet, chainId: expectedChainId, legacy: true };
      }
      json(res, 503, { error: "Wallet auth requires DATABASE_URL-backed nonce storage." });
      return null;
    }

    const credentialAction = String(auth?.action || action || "").trim();
    if (credentialAction !== action) {
      return rejectOrLegacy("ACTION_MISMATCH", "Wallet signature action does not match this request.");
    }

    if (auth?.chainId != null && Number(auth.chainId) !== expectedChainId) {
      return rejectOrLegacy("CHAIN_MISMATCH", "Wallet chain does not match this request.");
    }

    const nonce = String(auth.nonce || "").trim();
    const signature = String(auth.signature || "").trim();
    const clientMessage = String(auth.message || "").replace(/\r\n/g, "\n").trim();
    const expectedMessage = buildWalletActionMessage({
      action,
      walletAddress: wallet,
      chainId: expectedChainId,
      nonce,
      extraLines,
    });

    if (clientMessage && clientMessage !== expectedMessage) {
      console.warn(`[walletActionAuth] ${routeLabel}: client message differs from canonical (will verify signature on canonical)`, {
        expectedPreview: expectedMessage.slice(0, 160),
        clientPreview: clientMessage.slice(0, 160),
      });
    }

    let signatureValid = false;
    const isSolana =
      isSolanaChain(expectedChainId) || String(auth?.walletType || "").toLowerCase() === "solana";
    try {
      if (isSolana) {
        signatureValid = verifySolanaSignature(expectedMessage, signature, wallet);
      } else {
        signatureValid =
          normalizeAddress(ethers.verifyMessage(expectedMessage, signature), expectedChainId) === wallet;
      }
    } catch {
      signatureValid = false;
    }

    if (!signatureValid) {
      if (clientMessage && clientMessage !== expectedMessage) {
        return rejectOrLegacy("MESSAGE_MISMATCH", "Wallet signature message mismatch.");
      }
      return rejectOrLegacy("INVALID_SIGNATURE", "Invalid wallet signature.");
    }

    const consumed = await consumeNonce({ pool, chainId: expectedChainId, wallet, nonce });
    if (!consumed) {
      return rejectOrLegacy("NONCE_INVALID", "Wallet auth nonce invalid, expired, or already used. Please sign again.");
    }

    return { walletAddress: wallet, chainId: expectedChainId, legacy: false };
  } catch (error) {
    console.error(`[walletActionAuth] ${routeLabel} verify error`, error?.message || error);
    if (!enforce) {
      return { walletAddress: wallet, chainId: expectedChainId, legacy: true };
    }
    json(res, 500, { error: "Wallet auth verification failed.", code: "AUTH_VERIFY_ERROR" });
    return null;
  }
}
