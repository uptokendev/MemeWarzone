import crypto from "node:crypto";
import { ethers } from "ethers";
import { isSolanaChain, normalizeAddress, json } from "../../server/http.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(Array.from(BASE58_ALPHABET).map((char, index) => [char, index]));

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

export function buildProjectImportMessage({ action, walletAddress, chainId, nonce, tokenAddress = "" }) {
  const wallet = normalizeAddress(walletAddress, chainId);
  const lines = [
    "MemeWarzone Project Import",
    `Action: ${String(action || "")}`,
    `Wallet: ${wallet}`,
    `Chain ID: ${Number(chainId)}`,
  ];
  if (tokenAddress) lines.push(`Token: ${String(tokenAddress).trim()}`);
  lines.push(`Nonce: ${String(nonce || "")}`);
  return lines.join("\n");
}

async function consumeNonce(pool, { chainId, walletAddress, nonce }) {
  const result = await pool.query(
    `UPDATE public.auth_nonces
        SET used_at = NOW()
      WHERE chain_id = $1
        AND address = $2
        AND nonce = $3
        AND used_at IS NULL
        AND expires_at > NOW()
      RETURNING expires_at`,
    [chainId, walletAddress, nonce],
  );
  return Boolean(result.rows?.[0]);
}

export async function requireProjectImportAuth({ res, pool, auth, chainId, action, tokenAddress = "" }) {
  const id = Number(chainId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    json(res, 400, { error: "Invalid chain id.", code: "INVALID_CHAIN" });
    return null;
  }
  const wallet = normalizeAddress(auth?.walletAddress || auth?.address || "", id);
  if (!wallet) {
    json(res, 401, { error: "Wallet required.", code: "WALLET_REQUIRED" });
    return null;
  }
  if (Number(auth?.chainId) !== id) {
    json(res, 401, { error: "Wallet chain does not match request.", code: "CHAIN_MISMATCH" });
    return null;
  }
  if (String(auth?.action || "") !== action) {
    json(res, 401, { error: "Wallet signature action does not match request.", code: "ACTION_MISMATCH" });
    return null;
  }
  const nonce = String(auth?.nonce || "").trim();
  const signature = String(auth?.signature || "").trim();
  if (!nonce || !signature) {
    json(res, 401, { error: "Wallet signature required.", code: "SIGNATURE_REQUIRED" });
    return null;
  }
  if (!pool) {
    json(res, 503, { error: "Project import wallet auth requires database-backed nonce storage." });
    return null;
  }

  const message = buildProjectImportMessage({ action, walletAddress: wallet, chainId: id, nonce, tokenAddress });
  let valid = false;
  try {
    if (isSolanaChain(id)) {
      valid = verifySolanaSignature(message, signature, wallet);
    } else {
      valid = normalizeAddress(ethers.verifyMessage(message, signature), id) === wallet;
    }
  } catch {
    valid = false;
  }
  if (!valid) {
    json(res, 401, { error: "Invalid wallet signature.", code: "INVALID_SIGNATURE" });
    return null;
  }

  if (!(await consumeNonce(pool, { chainId: id, walletAddress: wallet, nonce }))) {
    json(res, 401, { error: "Wallet auth nonce invalid, expired, or already used.", code: "NONCE_INVALID" });
    return null;
  }
  return { walletAddress: wallet, chainId: id };
}
