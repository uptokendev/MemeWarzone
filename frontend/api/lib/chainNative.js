export function isSolanaChainId(chainId) {
  const id = Number(chainId);
  return id === 101 || id === 102;
}

export function isRobinhoodChainId(chainId) {
  const id = Number(chainId);
  return id === 4663 || id === 46630;
}

/** Native gas token for Warzone stakes, Support, and claims. Robinhood uses ETH, not RH. */
export function nativeSymbolFor(chainId) {
  if (isSolanaChainId(chainId)) return "SOL";
  if (isRobinhoodChainId(chainId)) return "ETH";
  return "BNB";
}
