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

// The wallet signs the whole post (trimmed, at most POST_MAX_CHARS), so no character of the stored
// body can be changed by someone who intercepts a signature.
function signedBody(body) {
  return String(body ?? "").trim();
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
    signedBody(body),
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
