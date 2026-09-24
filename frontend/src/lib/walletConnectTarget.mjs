/**
 * Which EVM chain an explicit wallet connect must land on, if any.
 *
 * Only a token page pins a chain: a Robinhood token cannot be traded from
 * BNB, so connecting on that page switches the wallet there. Everywhere else
 * the wallet's own network is respected (ensureSupportedEvmChain keeps an
 * allowed chain when no target is given) and the feed latches to it
 * afterwards (useLatchFeedChainToWallet).
 *
 * Until 2026-09-24 the modal asked resolveRobinhoodFeedChainId(), which
 * answers 4663 whenever Robinhood is merely ALLOWED, not selected. The day
 * Robinhood went into VITE_ALLOWED_CHAIN_IDS every EVM connect force-switched
 * MetaMask to Robinhood no matter what the user had chosen, and the same
 * branch made a BNB token page connect to Robinhood too.
 *
 * @returns {number|null} the chain to request from the wallet, or null to keep its network
 */
export function evmConnectTargetChainId({ onEvmTokenPage, pageChainId, isAllowedEvmChain }) {
  if (!onEvmTokenPage) return null;
  const chainId = Number(pageChainId);
  if (!Number.isInteger(chainId) || chainId <= 0) return null;
  return isAllowedEvmChain(chainId) ? chainId : null;
}
