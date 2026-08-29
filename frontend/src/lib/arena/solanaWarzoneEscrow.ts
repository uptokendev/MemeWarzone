import { isSolanaChainId } from "@/lib/chainConfig";

/** Shown whenever a Warzone money action is attempted on Solana before canonical arena_config validates. */
export const SOLANA_WARZONE_ESCROW_NOT_LIVE =
  "Solana Warzone escrow is not live yet. Stake, Support, and claims cannot move SOL until canonical arena_config is validated on this cluster. Use BNB or Robinhood for on-chain Warzone money.";

export function isSolanaWarzoneChain(chainId?: number | null): boolean {
  const id = Number(chainId);
  return isSolanaChainId(id) || id === 102;
}

/** Live only when the API/on-chain probe has proven canonical Arena config. Prize-boost UI stays ops-only. */
export function isSolanaWarzoneMoneyLive(status?: { configured?: boolean; live?: boolean } | null): boolean {
  if (!status) return false;
  if (status.live === false) return false;
  return Boolean(status.configured);
}
