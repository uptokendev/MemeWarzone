// Last check before an EVM transaction is sent (2026-10-01). Switching MetaMask between BNB and Robinhood
// could leave the page on one chain and the wallet on the other; the transaction then went to an address
// that has no contract on the wallet's chain, and any value it carried (a first buy, a buy) would be lost.
// Both reads go through the wallet's own provider, i.e. the chain the transaction will actually land on.

const CHAIN_LABELS = {
  1: "Ethereum",
  56: "BNB Chain",
  97: "BNB testnet",
  4663: "Robinhood Chain",
  46630: "Robinhood testnet",
};

export function chainLabel(chainId) {
  return CHAIN_LABELS[Number(chainId)] || `chain ${Number(chainId)}`;
}

export async function assertWalletOnChain(signer, expectedChainId, contractAddress) {
  const provider = signer?.provider;
  if (!provider) throw new Error("Wallet provider is unavailable. Reconnect your wallet and try again.");
  const network = await provider.getNetwork();
  const actual = Number(network?.chainId);
  const expected = Number(expectedChainId);
  if (actual !== expected) {
    throw new Error(
      `Your wallet is on ${chainLabel(actual)}, but this is on ${chainLabel(expected)}. Switch your wallet to ${chainLabel(expected)}, refresh the page and try again.`,
    );
  }
  if (contractAddress) {
    const code = await provider.getCode(contractAddress);
    if (!code || code === "0x") {
      throw new Error(`The contract ${String(contractAddress).slice(0, 10)}… does not exist on ${chainLabel(expected)}. Refresh the page and try again.`);
    }
  }
}
