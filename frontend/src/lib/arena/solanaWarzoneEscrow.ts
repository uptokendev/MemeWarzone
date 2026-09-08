import { isSolanaChainId } from "@/lib/chainConfig";
import { isSolanaWarzoneMoneyLive as liveFromProbe } from "@/lib/solanaArenaLayout.mjs";

/** Shown whenever a Warzone money action is attempted on Solana before canonical arena_config validates. */
export const SOLANA_WARZONE_ESCROW_NOT_LIVE =
  "Solana Warzone escrow is not live yet. Stake, Support, and claims cannot move SOL until canonical arena_config is validated on this cluster. Use BNB or Robinhood for on-chain Warzone money.";

export function isSolanaWarzoneChain(chainId?: number | null): boolean {
  const id = Number(chainId);
  return isSolanaChainId(id) || id === 102;
}

/** Live only when the probe explicitly set both flags true. Missing live is blocked. */
export function isSolanaWarzoneMoneyLive(status?: { configured?: boolean; live?: boolean } | null): boolean {
  return liveFromProbe(status);
}
