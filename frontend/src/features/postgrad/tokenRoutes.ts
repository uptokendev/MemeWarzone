import { getPostGradTokenDetailRoute, getPublicTokenDetailRoute } from "@/features/postgrad/identityRoutes";

/**
 * Canonical Arena token page. Includes chainId so imported tokens (especially
 * BNB testnet 97) resolve to ImportedTokenDetails instead of a native campaign page.
 */
export function getArenaTokenRoute(tokenId?: string | null, chainId?: number | null) {
  if (chainId) return getPublicTokenDetailRoute({ tokenAddress: tokenId, chainId });
  return getPostGradTokenDetailRoute(tokenId);
}
