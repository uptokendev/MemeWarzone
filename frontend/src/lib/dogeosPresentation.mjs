// DogeOS Chikyū testnet (chain 6281971) display values, in one place.
// Plain .mjs so the .mjs presentation modules (and their node tests) can import it; the .ts side
// gets the same chain id, symbol and label from chainConfig.ts, and dogeosPresentation.test.mjs
// checks the two agree. DogeOS coins graduate into MuchFi (founder 2026-10-10, details pending),
// so the DEX name lives here and nowhere else.

export const DOGEOS_TESTNET_CHAIN_ID = 6281971;
export const DOGEOS_NATIVE_SYMBOL = "DOGE";
export const DOGEOS_CHAIN_LABEL = "DogeOS Chikyū Testnet";
export const DOGEOS_EXPLORER_BASE = "https://dogeos-testnet.l2scan.co";
export const DOGEOS_DEX_LABEL = "MuchFi";

export function isDogeosTestnetChain(chainId) {
  return Number(chainId) === DOGEOS_TESTNET_CHAIN_ID;
}
