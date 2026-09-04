const SUPPORTED_EVM_CHAIN_IDS = new Set([56, 97, 4663, 46630]);

export function defaultEvmChainId() {
  const n = Number(process.env.DEFAULT_EVM_CHAIN_ID || process.env.VITE_DEFAULT_CHAIN_ID || 56);
  return SUPPORTED_EVM_CHAIN_IDS.has(n) ? n : 56;
}
