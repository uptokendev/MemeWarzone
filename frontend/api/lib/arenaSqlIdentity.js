import { isSolanaChainId } from "./chainNative.js";

/**
 * SQL identity comparison for Arena token/campaign addresses.
 * Solana Base58 identities are case-sensitive; EVM addresses are not.
 * `expression` must be a trusted static SQL fragment supplied by server code.
 */
export function arenaSqlIdentityEquals(chainId, expression, parameter = "$2") {
  if (isSolanaChainId(Number(chainId))) {
    return `coalesce(${expression}, '') = ${parameter}`;
  }
  return `lower(coalesce(${expression}, '')) = lower(${parameter})`;
}
