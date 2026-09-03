import { isSolanaChainId } from "./chainNative.js";

/**
 * SQL identity comparison for Arena token/campaign/wallet addresses.
 * Solana Base58 identities are case-sensitive; EVM addresses are not.
 * `expression` must be a trusted static SQL fragment supplied by server code.
 */
export function arenaSqlIdentityEquals(chainId, expression, parameter = "$2") {
  if (isSolanaChainId(Number(chainId))) {
    return `coalesce(${expression}, '') = ${parameter}`;
  }
  return `lower(coalesce(${expression}, '')) = lower(${parameter})`;
}

export function arenaSqlIdentityAny(chainId, expression, parameter = "$1") {
  if (isSolanaChainId(Number(chainId))) {
    return `coalesce(${expression}, '') = any(${parameter}::text[])`;
  }
  return `lower(coalesce(${expression}, '')) = any(${parameter}::text[])`;
}

export function arenaSqlIdentityValues(chainId, values) {
  const rows = Array.isArray(values) ? values : [];
  if (isSolanaChainId(Number(chainId))) return rows.map((value) => String(value));
  return rows.map((value) => String(value).toLowerCase());
}
