import { Connection } from "@solana/web3.js";
import { getPublicRpcUrl, SOLANA_CHAIN_ID } from "@/lib/chainConfig";

let cached: { url: string; connection: Connection } | null = null;

export function solanaReadRpcUrl(): string {
  return String(import.meta.env.VITE_SOLANA_RPC || "").trim() || getPublicRpcUrl(SOLANA_CHAIN_ID);
}

/**
 * One browser Connection for read-only Token Details traffic.
 * Public Solana RPCs 429 quickly; default web3.js retries make that worse.
 */
export function getSolanaReadConnection(): Connection {
  const url = solanaReadRpcUrl();
  if (cached && cached.url === url) return cached.connection;
  const connection = new Connection(url, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
  });
  cached = { url, connection };
  return connection;
}
