// Live native balances for the finance inventory list.
//
// Reuses the fee-routing readers (eth_getBalance / getBalance over JSON-RPC)
// and their RPC lists. Read-only: nothing is built, signed or sent, and no key
// is loaded. A read that fails comes back as status "unknown" with no amount,
// never as zero.

import { getRpcUrls } from "./getServerReadProvider.js";
import { atomicToDecimal, solanaRpcUrls } from "./financeFeeRouting.js";
import { readEvmNative, readSolanaLamports } from "./financeFeeRoutingReaders.js";

const CACHE_TTL_MS = 60_000;
const cache = new Map();

function devnetRpcUrls(env) {
  const urls = [];
  for (const name of ["SOLANA_DEVNET_RPC_HTTP", "SOLANA_DEVNET_RPC_URL"]) {
    for (const part of String(env[name] || "").split(",")) {
      const url = part.trim();
      if (url && !urls.includes(url)) urls.push(url);
    }
  }
  urls.push("https://api.devnet.solana.com");
  return [...new Set(urls)];
}

function nativeAsset(network) {
  if (network.chain === "solana") return { asset: "SOL", decimals: 9 };
  return { asset: network.asset || "BNB", decimals: network.decimals ?? 18 };
}

export function inventoryRpcUrls(network, env = process.env) {
  if (network.chain === "solana") {
    if (network.environment === "production" && network.cluster === "mainnet-beta") return solanaRpcUrls(env);
    if (network.environment === "staging" && network.cluster === "devnet") return devnetRpcUrls(env);
    return [];
  }
  return getRpcUrls(network.chainId);
}

async function readOne(item, network, ctx) {
  const { asset, decimals } = nativeAsset(network);
  if (ctx.urls.length === 0) {
    return { asset, decimals, raw: null, amount: null, status: "unknown", source: "rpc", asOf: null, error: "No RPC is configured for this network on the API." };
  }
  try {
    const read = network.chain === "solana"
      ? await ctx.readers.readSolanaLamports({ urls: ctx.urls, address: item.address, fetchImpl: ctx.fetchImpl })
      : await ctx.readers.readEvmNative({ urls: ctx.urls, address: item.address, fetchImpl: ctx.fetchImpl });
    const amount = atomicToDecimal(read.raw, decimals);
    if (amount == null) throw new Error("Balance read returned a malformed amount.");
    return { asset, decimals, raw: String(read.raw), amount, status: "ok", source: `rpc:${read.rpc}`, asOf: ctx.now() };
  } catch (error) {
    return { asset, decimals, raw: null, amount: null, status: "unknown", source: "rpc", asOf: null, error: String(error?.message || "Balance read failed.").slice(0, 300) };
  }
}

/** Returns the items with a `balance` added to each. Never throws for a failed read. */
export async function withInventoryBalances(items, network, {
  env = process.env,
  fetchImpl = fetch,
  readers = { readEvmNative, readSolanaLamports },
  now = () => new Date().toISOString(),
} = {}) {
  const ctx = { urls: inventoryRpcUrls(network, env), fetchImpl, readers, now };
  const balances = await Promise.all(items.map((item) => readOne(item, network, ctx)));
  return items.map((item, index) => ({ ...item, balance: balances[index] }));
}

export async function cachedInventoryBalances(items, network, options) {
  const key = `${network.chainId}:${network.cluster || ""}:${items.map((item) => item.address).join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await withInventoryBalances(items, network, options);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function clearInventoryBalanceCache() {
  cache.clear();
}
