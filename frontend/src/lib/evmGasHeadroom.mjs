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
