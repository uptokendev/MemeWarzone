import { isSolanaChainId } from "@/lib/chainConfig";

/** Shown whenever a Warzone money action is attempted on Solana before the treasury upgrade. */
export const SOLANA_WARZONE_ESCROW_NOT_LIVE =
  "Solana Warzone escrow is not live yet. Stake, Support, and claims cannot move SOL until the next mwz_rewards_treasury upgrade. Use BNB or Robinhood for on-chain Warzone money.";

export function isSolanaWarzoneChain(chainId?: number | null): boolean {
  const id = Number(chainId);
  return isSolanaChainId(id) || id === 102;
}
