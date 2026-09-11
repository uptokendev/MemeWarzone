import { CURRENT_SOLANA_CHAIN_ID, LEGACY_SOLANA_CHAIN_ID } from "../../shared/solanaCurrentAuthority.mjs";

export function isSolanaChainId(chainId) {
  return Number(chainId) === CURRENT_SOLANA_CHAIN_ID;
}

export function isRobinhoodChainId(chainId) {
  const id = Number(chainId);
  return id === 4663 || id === 46630;
}

export function isBnbChainId(chainId) {
  const id = Number(chainId);
  return id === 56 || id === 97;
}

/** Native gas token for current Warzone stakes, Support, and claims. Robinhood uses ETH, not RH. */
export function nativeSymbolFor(chainId) {
  const id = Number(chainId);
  if (id === LEGACY_SOLANA_CHAIN_ID) {
    throw new Error("Legacy Solana application chain 102 is not current financial authority.");
  }
  if (isSolanaChainId(id)) return "SOL";
  if (isRobinhoodChainId(id)) return "ETH";
  if (isBnbChainId(id)) return "BNB";
  throw new Error(`Unsupported current application chain: ${String(chainId)}`);
}
