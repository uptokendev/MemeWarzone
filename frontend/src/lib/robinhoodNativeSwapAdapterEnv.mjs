/**
 * Which RobinhoodV3NativeSwapAdapter the app trades through (direct-native Robinhood V3 routes: post-graduation
 * markets and imported coins on the adapter path). Pure.
 *
 * VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS_<chainId>: RobinhoodV3NativeSwapAdapterV2
 * (docs/evm-launch/CO-IMPORT-SWAP-FEE.md A.2, same ABI). When set it wins; chain-suffixed only, because the
 * V2 address differs per chain. Unset or empty: VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS[_<chainId>],
 * looked up exactly as before (today's adapter).
 */
import { DOGEOS_TESTNET_CHAIN_ID } from "./dogeosPresentation.mjs";

export const NATIVE_SWAP_ADAPTER_ENV = "VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_ADDRESS";
export const NATIVE_SWAP_ADAPTER_V2_ENV = "VITE_ROBINHOOD_V3_NATIVE_SWAP_ADAPTER_V2_ADDRESS";

export function robinhoodNativeSwapAdapterAddress(env, chainId) {
  const source = env || {};
  const v2 = String(source[`${NATIVE_SWAP_ADAPTER_V2_ENV}_${chainId}`] ?? "").trim();
  if (v2) return v2;
  // DogeOS Chikyu (6281971): the unsuffixed name is Robinhood's adapter, so DogeOS reads only its own suffixed name.
  if (Number(chainId) === DOGEOS_TESTNET_CHAIN_ID) return String(source[`${NATIVE_SWAP_ADAPTER_ENV}_${chainId}`] ?? "").trim();
  return String(source[`${NATIVE_SWAP_ADAPTER_ENV}_${chainId}`] ?? source[NATIVE_SWAP_ADAPTER_ENV] ?? "").trim();
}
