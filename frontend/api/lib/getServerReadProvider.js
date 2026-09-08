import { ethers } from "ethers";

/**
 * Server equivalent of src/lib/readProvider.ts — keep config choices in sync.
 *
 * IMPORTANT (same as client):
 * - We DISABLE batching (batchMaxCount: 1) because public endpoints often
 *   rate-limit when requests are batched.
 * - We set staticNetwork to avoid extra "detectNetwork" chatter.
 * - Primary env RPCs are tried first; public fallbacks are only a last resort.
 *
 * Supports env vars:
 *   BSC_RPC_HTTP_${chainId} / ROBINHOOD_RPC_HTTP_${chainId} (CSV allowed)
 *   VITE_PUBLIC_RPC_${chainId}
 *   ROBINHOOD_TESTNET_RPC_URL / ROBINHOOD_MAINNET_RPC_URL
 *   BSC_RPC_HTTP / VITE_BSC_MAINNET_RPC / VITE_BSC_TESTNET_RPC
 */

const providerCache = new Map();

const PUBLIC_FALLBACKS = {
  56: [
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed1.binance.org",
    "https://bsc-dataseed2.binance.org",
  ],
  97: [
    "https://data-seed-prebsc-1-s1.binance.org:8545",
    "https://data-seed-prebsc-2-s1.binance.org:8545",
    "https://bsc-testnet.bnbchain.org",
  ],
  // Official Robinhood public RPCs are rate-limited; production should provide
  // managed endpoints through ROBINHOOD_RPC_HTTP_* instead of relying on these.
  4663: ["https://rpc.mainnet.chain.robinhood.com"],
  46630: ["https://rpc.testnet.chain.robinhood.com"],
};

function networkName(chainId) {
  const id = Number(chainId);
  if (id === 56) return "bsc";
  if (id === 97) return "bsc-testnet";
  if (id === 4663) return "robinhood";
  if (id === 46630) return "robinhood-testnet";
  return `chain-${id}`;
}

function csvValues(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstCsvValue(value) {
  return csvValues(value)[0] || "";
}

function uniqueUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls) {
    const url = String(raw || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Ordered RPC candidates for a chain: configured env first, then public fallback. */
export function getRpcUrls(chainId) {
  const id = Number(chainId);
  const configured = [
    ...csvValues(process.env[`ROBINHOOD_RPC_HTTP_${id}`]),
    ...csvValues(process.env[`BSC_RPC_HTTP_${id}`]),
    ...csvValues(process.env[`VITE_PUBLIC_RPC_${id}`]),
  ];

  if (id === 56) {
    configured.push(
      ...csvValues(process.env.BSC_RPC_HTTP_56),
      ...csvValues(process.env.VITE_BSC_MAINNET_RPC),
      ...csvValues(process.env.BSC_MAINNET_RPC),
      ...csvValues(process.env.BSC_MAINNET_RPC_URL),
      ...csvValues(process.env.BSC_RPC_HTTP),
    );
  } else if (id === 97) {
    configured.push(
      ...csvValues(process.env.BSC_RPC_HTTP_97),
      ...csvValues(process.env.VITE_BSC_TESTNET_RPC),
      ...csvValues(process.env.BSC_TESTNET_RPC),
      ...csvValues(process.env.BSC_TESTNET_RPC_URL),
      ...csvValues(process.env.BSC_RPC_HTTP),
    );
  } else if (id === 4663) {
    configured.push(
      ...csvValues(process.env.ROBINHOOD_RPC_HTTP_4663),
      ...csvValues(process.env.ROBINHOOD_MAINNET_RPC_URL),
      ...csvValues(process.env.ROBINHOOD_MAINNET_RPC),
    );
  } else if (id === 46630) {
    configured.push(
      ...csvValues(process.env.ROBINHOOD_RPC_HTTP_46630),
      ...csvValues(process.env.ROBINHOOD_TESTNET_RPC_URL),
      ...csvValues(process.env.ROBINHOOD_TESTNET_RPC),
    );
  } else {
    configured.push(...csvValues(process.env.BSC_RPC_HTTP));
  }

  return uniqueUrls([...configured, ...(PUBLIC_FALLBACKS[id] || [])]);
}

/** @deprecated Prefer getRpcUrls / getServerReadProvider with failover. */
export function getRpcUrl(chainId) {
  return getRpcUrls(chainId)[0] || "";
}

function makeProvider(url, chainId) {
  const network = ethers.Network.from(Number(chainId));
  network.name = networkName(chainId);
  return new ethers.JsonRpcProvider(url, network, {
    staticNetwork: network,
    batchMaxCount: 1,
    batchStallTime: 0,
  });
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || "").slice(0, 48);
  }
}

/** Returns a read-only provider for server-side on-chain reads. */
export async function getServerReadProvider(chainId) {
  const numChainId = Number(chainId);
  if (!Number.isFinite(numChainId)) {
    throw new Error(`Invalid chainId for getServerReadProvider: ${chainId}`);
  }

  const cached = providerCache.get(numChainId);
  if (cached) {
    try {
      await cached.provider.getBlockNumber();
      return cached.provider;
    } catch {
      providerCache.delete(numChainId);
    }
  }

  const urls = getRpcUrls(numChainId);
  if (!urls.length) {
    throw new Error(
      `Missing RPC URL for chainId=${numChainId} (set ROBINHOOD_RPC_HTTP_${numChainId}, BSC_RPC_HTTP_${numChainId}, or VITE_PUBLIC_RPC_${numChainId})`,
    );
  }

  const errors = [];
  for (const url of urls) {
    const provider = makeProvider(url, numChainId);
    try {
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== numChainId) {
        throw new Error(`RPC returned chainId=${network.chainId}; expected ${numChainId}`);
      }
      await provider.getBlockNumber();
      providerCache.set(numChainId, { provider, url });
      return provider;
    } catch (error) {
      errors.push(`${hostOf(url)}: ${String(error?.shortMessage || error?.message || error)}`);
      try {
        provider.destroy?.();
      } catch {
        // ignore
      }
    }
  }

  throw new Error(
    `All RPC endpoints failed for chainId=${numChainId}. Tried: ${errors.join(" | ")}`,
  );
}

/** Sync helper for call sites that already hold a URL string. */
export function getServerReadProviderForUrl(chainId, url) {
  if (!url) {
    throw new Error(`Missing RPC URL for chainId=${chainId}`);
  }
  return makeProvider(url, Number(chainId));
}

export { firstCsvValue };
