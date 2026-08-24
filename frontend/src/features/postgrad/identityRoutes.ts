function normalizeIdentity(value?: string | null) {
  return String(value ?? "").trim();
}

function isUsableIdentity(value?: string | null) {
  const identity = normalizeIdentity(value);
  if (!identity) return false;
  if (identity.startsWith("pending-")) return false;
  return identity.length > 4;
}

/**
 * Canonical public token page route.
 * Prefer the ERC-20 token address; fall back to campaign only when token is unknown.
 * (Campaign is the bonding/vote contract; token is the public identity.)
 */
export function getPublicTokenDetailRoute(input?: {
  tokenAddress?: string | null;
  campaignAddress?: string | null;
  identity?: string | null;
  chainId?: number | null;
} | string | null) {
  if (typeof input === "string" || input == null) {
    return getPostGradTokenDetailRoute(input);
  }
  const preferred =
    normalizeIdentity(input.tokenAddress) ||
    normalizeIdentity(input.identity) ||
    normalizeIdentity(input.campaignAddress);
  const base = getPostGradTokenDetailRoute(preferred);
  if (!base) return null;
  const chainId = Number(input.chainId);
  // 0x → BNB mainnet, base58 → Solana. Only pin non-default networks (BNB testnet 97).
  if (chainId === 97 || chainId === 102) {
    return `${base}${base.includes("?") ? "&" : "?"}chainId=${chainId}`;
  }
  return base;
}

export function getPostGradTokenDetailRoute(identity?: string | null) {
  const value = normalizeIdentity(identity);
  if (!isUsableIdentity(value)) return null;
  return `/token/${encodeURIComponent(value)}`;
}

export function getPostGradWarRoomSearchRoute(label?: string | null) {
  const value = normalizeIdentity(label);
  return value ? `/war-room?search=${encodeURIComponent(value)}` : "/war-room";
}
