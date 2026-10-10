/**
 * Gas limit for an EVM curve trade: the node's estimate + 25% + 50,000.
 *
 * During a coin's 60 s launch window the trade fee changes every second, and with it the gas the fee
 * router's split needs, so a raw estimate can be short by the time the transaction lands (BSC testnet
 * 2026-10-09, tx 0x6aa06536: estimated 454,453, needed 455,225, reverted out of gas after the router call).
 * When the estimate fails, `floor` is returned (undefined = leave the limit to the wallet, as before), so a
 * revert or an unsupported method still surfaces from the send itself.
 */
export async function gasWithHeadroom(estimate, floor) {
  try {
    const raw = BigInt(await estimate());
    const padded = (raw * 125n) / 100n + 50_000n;
    return floor != null && padded < BigInt(floor) ? BigInt(floor) : padded;
  } catch {
    return floor == null ? undefined : BigInt(floor);
  }
}

/** Robinhood Chain mainnet and testnet: Arbitrum Orbit chains, where a transaction pays the block base fee. */
export const BASE_FEE_PRICED_CHAIN_IDS = Object.freeze([4663, 46630]);

/**
 * The legacy gas price to send with. On Robinhood `eth_gasPrice` returns the current base fee, and the base fee
 * moves a little from block to block, so sending exactly that price is refused once the next block's base fee is
 * higher ("max fee per gas less than block base fee", 2026-10-10: price 20,034,000 vs base fee 20,044,000; the
 * wallet shows it as "missing revert data" on estimateGas). The price there is a cap: the chain charges the base
 * fee, so 50% headroom costs nothing. Other chains are unchanged.
 */
export function legacyGasPriceFor(chainId, gasPrice) {
  const price = BigInt(gasPrice);
  if (price <= 0n) return price;
  return BASE_FEE_PRICED_CHAIN_IDS.includes(Number(chainId)) ? (price * 3n) / 2n : price;
}
