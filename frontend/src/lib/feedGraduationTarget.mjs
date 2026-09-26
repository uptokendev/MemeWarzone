/** BNB LaunchFactory default. Must not be reused as a SOL or ETH amount. */
export const DEFAULT_BNB_GRAD_TARGET = 50;
export const DEFAULT_MAINNET_GRAD_USD = 30_000;
export const DEFAULT_TESTNET_GRAD_USD = 6;

const SOLANA_CHAIN_IDS = new Set([101, 102]);
const ROBINHOOD_CHAIN_IDS = new Set([4663, 46630]);
const TESTNET_CHAIN_IDS = new Set([97, 102, 46630]);

export function defaultGraduationUsd(chainId) {
  const id = Number(chainId);
  if (TESTNET_CHAIN_IDS.has(id) && (SOLANA_CHAIN_IDS.has(id) || ROBINHOOD_CHAIN_IDS.has(id))) {
    return DEFAULT_TESTNET_GRAD_USD;
  }
  if (SOLANA_CHAIN_IDS.has(id) || ROBINHOOD_CHAIN_IDS.has(id)) return DEFAULT_MAINNET_GRAD_USD;
  return null;
}

export function leakedBnbGraduationDefault(chainId, suppliedTarget) {
  const id = Number(chainId);
  if (!SOLANA_CHAIN_IDS.has(id) && !ROBINHOOD_CHAIN_IDS.has(id)) return false;
  return Number(suppliedTarget) === DEFAULT_BNB_GRAD_TARGET;
}

/**
 * Native units to 100% on the homepage bar.
 * BNB stays 50. Solana/Robinhood convert the USD graduation default by spot.
 * A supplied target of 50 on those chains is the BNB default leaking through.
 */
export function nativeGraduationTarget({ chainId, nativeUsd, suppliedTarget } = {}) {
  const supplied = Number(suppliedTarget);
  const leaked = leakedBnbGraduationDefault(chainId, supplied);
  if (Number.isFinite(supplied) && supplied > 0 && !leaked) return supplied;
  const usd = defaultGraduationUsd(chainId);
  if (usd == null) return DEFAULT_BNB_GRAD_TARGET;
  const px = Number(nativeUsd);
  if (!Number.isFinite(px) || px <= 0) return null;
  return usd / px;
}

export function bondingProgressPct({
  chainId,
  raisedNative,
  nativeUsd,
  suppliedTarget,
  isDex = false,
} = {}) {
  if (isDex) return 100;
  const target = nativeGraduationTarget({ chainId, nativeUsd, suppliedTarget });
  const raised = Number(raisedNative);
  if (!Number.isFinite(target) || target <= 0 || !Number.isFinite(raised) || raised < 0) return null;
  return Math.max(0, Math.min(100, (raised / target) * 100));
}
