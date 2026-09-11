import { resolveCurrentSolanaAuthority } from "../../../shared/solanaCurrentAuthority.mjs";

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
 * Prefer the token address; fall back to campaign only when token is unknown.
 * Solana current authority is always chain 101 plus an explicit runtime
 * environment/cluster pair. Legacy 102 is never allowed to select a route.
 */
export function getPublicTokenDetailRoute(input?: {
  tokenAddress?: string | null;
  campaignAddress?: string | null;
  identity?: string | null;
  chainId?: number | null;
  environment?: string | null;
  cluster?: string | null;
  solanaCluster?: string | null;
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
  if (chainId === 102) return null;

  // Preserve the existing BNB testnet route pin.
  if (chainId === 97) {
    return `${base}${base.includes("?") ? "&" : "?"}chainId=97`;
  }

  if (chainId === 101) {
    const authority = resolveCurrentSolanaAuthority({
      chainId,
      environment: input.environment ?? import.meta.env.VITE_RUNTIME_ENVIRONMENT,
      cluster: input.solanaCluster ?? input.cluster ?? import.meta.env.VITE_SOLANA_CLUSTER,
    });
    if (!authority) return null;

    const query = new URLSearchParams({
      chainId: String(authority.chainId),
      environment: authority.environment,
      cluster: authority.cluster,
    });
    return `${base}${base.includes("?") ? "&" : "?"}${query.toString()}`;
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
