export const SOLANA_REWARD_MAINNET_CHAIN_ID = 101;
export const SOLANA_REWARD_DEVNET_CHAIN_ID = 102;

export function isSolanaRewardChainId(chainId?: number | null): boolean {
  return Number(chainId) === SOLANA_REWARD_MAINNET_CHAIN_ID || Number(chainId) === SOLANA_REWARD_DEVNET_CHAIN_ID;
}

/**
 * The public app remains on canonical Solana chain id 101. A dedicated devnet
 * certification deployment may opt the reward rail into 102 without teaching the
 * rest of the launchpad that 102 is a user-facing production chain.
 */
export function getConfiguredSolanaRewardChainId(): number {
  const requested = Number(import.meta.env.VITE_SOLANA_REWARD_CHAIN_ID || SOLANA_REWARD_MAINNET_CHAIN_ID);
  const devnetEnabled = String(import.meta.env.VITE_ENABLE_SOLANA_DEVNET_REWARDS || "").trim().toLowerCase() === "true";
  if (requested === SOLANA_REWARD_DEVNET_CHAIN_ID && devnetEnabled) return SOLANA_REWARD_DEVNET_CHAIN_ID;
  return SOLANA_REWARD_MAINNET_CHAIN_ID;
}

export function getSolanaRewardRpcUrl(chainId: number): string {
  if (Number(chainId) === SOLANA_REWARD_DEVNET_CHAIN_ID) {
    return String(
      import.meta.env.VITE_SOLANA_DEVNET_RPC ||
      import.meta.env.VITE_PUBLIC_RPC_102 ||
      import.meta.env.VITE_SOLANA_RPC ||
      "https://api.devnet.solana.com"
    ).trim();
  }

  return String(
    import.meta.env.VITE_SOLANA_RPC ||
    import.meta.env.VITE_SOLANA_MAINNET_RPC ||
    import.meta.env.VITE_PUBLIC_RPC_SOLANA ||
    import.meta.env.VITE_PUBLIC_RPC_101 ||
    ""
  ).trim();
}
