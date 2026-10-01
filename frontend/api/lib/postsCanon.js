import { isAddress, isSolanaAddress, isSolanaChain } from "../../server/http.js";

export const POST_MAX_CHARS = 280;
export const POST_RATE_LIMIT = 5;
export const POST_RATE_WINDOW_MINUTES = 10;

export function canonPostWallet(chainId, value) {
  const raw = String(value ?? "").trim();
  if (isSolanaChain(chainId) || isSolanaAddress(raw)) return isSolanaAddress(raw) ? raw : "";
  const lower = raw.toLowerCase();
  return isAddress(lower) ? lower : "";
}

export function canonPostAddress(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (isSolanaAddress(raw)) return raw;
  const lower = raw.toLowerCase();
  return isAddress(lower) ? lower : "";
}

function bodyPreview(body) {
  return String(body ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
}

export function buildPostCreateMessage({ chainId, address, nonce, body }) {
  const solana = isSolanaChain(chainId) || isSolanaAddress(address);
  return [
    "MemeWarzone Post",
    "Action: POST_CREATE",
    `ChainId: ${chainId}`,
    `Address: ${solana ? address : String(address).toLowerCase()}`,
    `Nonce: ${nonce}`,
    "",
    bodyPreview(body),
  ].join("\n");
}

export function buildPostDeleteMessage({ chainId, address, nonce, postId }) {
  const solana = isSolanaChain(chainId) || isSolanaAddress(address);
  return [
    "MemeWarzone Post",
    "Action: POST_DELETE",
    `ChainId: ${chainId}`,
    `Address: ${solana ? address : String(address).toLowerCase()}`,
    `PostId: ${postId}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}
