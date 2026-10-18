/** Configured Solana HTTP RPCs. No public mainnet default: an empty list is a skip. */
export function solanaConfiguredRpcUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = String(env.SOLANA_RPC_HTTP || env.SOLANA_RPC_URL || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^https?:\/\//i.test(part));
}
