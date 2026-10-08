import { ethers } from "ethers";
import { getPublicRpcUrls, type SupportedChainId } from "./chainConfig";
import { makeFailoverReadProvider } from "./readProviderFailover.mjs";

// Cache 1 read provider per chain id
const providerCache = new Map<number, ethers.AbstractProvider>();

function networkName(chainId: number) {
  return chainId === 56 ? "bsc" : "bsc-testnet";
}

/**
 * Read-only JSON-RPC provider for public data (logs, reads).
 *
 * IMPORTANT:
 * - We DISABLE batching (batchMaxCount: 1) because public BSC endpoints
 *   often rate-limit when getLogs requests are batched.
 * - We set staticNetwork to avoid extra "detectNetwork" chatter.
 */
export function getReadProvider(chainId: SupportedChainId): ethers.AbstractProvider {
  const cached = providerCache.get(chainId);
  if (cached) return cached as any;

  const urls = getPublicRpcUrls(chainId);
  if (!urls.length) throw new Error(`Missing public RPC url for chainId=${chainId}`);

  // Pin network to avoid ethers "network changed" errors when the wallet/network flips or
  // when an endpoint is flaky during detection.
  const network = ethers.Network.from(chainId);
  (network as any).name = networkName(chainId);

  const options = {
    // IMPORTANT: In ethers v6, set staticNetwork to the Network object (not boolean).
    staticNetwork: network,
    // Disable batching to reduce "-32005 rate limit" issues
    batchMaxCount: 1,
    batchStallTime: 0,
  } as any;

  // One answer per request, no quorum: ethers FallbackProvider can throw "quorum not met"
  // on BSC when one public RPC replies and another lags/fails, even if the returned data is
  // valid. The list is tried in order only when a URL fails or rate-limits the request
  // (readProviderFailover.mjs); with one URL this is a plain JsonRpcProvider as before.
  const provider: ethers.AbstractProvider = makeFailoverReadProvider(ethers, urls, network, options);

  providerCache.set(chainId, provider);
  return provider;
}
