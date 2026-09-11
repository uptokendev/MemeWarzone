export const CURRENT_SOLANA_CHAIN_ID = 101;
export const LEGACY_SOLANA_CHAIN_ID = 102;

export const SOLANA_STAGING_ENVIRONMENT = "staging";
export const SOLANA_PRODUCTION_ENVIRONMENT = "production";
export const SOLANA_DEVNET_CLUSTER = "devnet";
export const SOLANA_MAINNET_CLUSTER = "mainnet-beta";

export function normalizeSolanaEnvironment(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === SOLANA_STAGING_ENVIRONMENT) return SOLANA_STAGING_ENVIRONMENT;
  if (normalized === SOLANA_PRODUCTION_ENVIRONMENT) return SOLANA_PRODUCTION_ENVIRONMENT;
  return "";
}

export function normalizeSolanaCluster(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === SOLANA_DEVNET_CLUSTER) return SOLANA_DEVNET_CLUSTER;
  if (normalized === SOLANA_MAINNET_CLUSTER) return SOLANA_MAINNET_CLUSTER;
  return "";
}

/**
 * Canonical current Solana authority is one application chain (101) plus an
 * explicit environment/cluster pair. Legacy application chain 102 is never a
 * current authority selector. Aliases are deliberately rejected so authority
 * cannot be inferred from older naming conventions.
 */
export function resolveCurrentSolanaAuthority({ chainId, environment, cluster } = {}) {
  if (Number(chainId) !== CURRENT_SOLANA_CHAIN_ID) return null;

  const normalizedEnvironment = normalizeSolanaEnvironment(environment);
  const normalizedCluster = normalizeSolanaCluster(cluster);
  if (!normalizedEnvironment || !normalizedCluster) return null;

  if (
    normalizedEnvironment === SOLANA_STAGING_ENVIRONMENT &&
    normalizedCluster === SOLANA_DEVNET_CLUSTER
  ) {
    return {
      chainId: CURRENT_SOLANA_CHAIN_ID,
      environment: SOLANA_STAGING_ENVIRONMENT,
      cluster: SOLANA_DEVNET_CLUSTER,
    };
  }

  if (
    normalizedEnvironment === SOLANA_PRODUCTION_ENVIRONMENT &&
    normalizedCluster === SOLANA_MAINNET_CLUSTER
  ) {
    return {
      chainId: CURRENT_SOLANA_CHAIN_ID,
      environment: SOLANA_PRODUCTION_ENVIRONMENT,
      cluster: SOLANA_MAINNET_CLUSTER,
    };
  }

  return null;
}

export function isCurrentSolanaStagingAuthority(input) {
  return resolveCurrentSolanaAuthority(input)?.environment === SOLANA_STAGING_ENVIRONMENT;
}

export function isCurrentSolanaProductionAuthority(input) {
  return resolveCurrentSolanaAuthority(input)?.environment === SOLANA_PRODUCTION_ENVIRONMENT;
}

export function currentSolanaAuthorityOrThrow(input, message = "Invalid current Solana chain/environment authority.") {
  const authority = resolveCurrentSolanaAuthority(input);
  if (!authority) {
    const error = new Error(message);
    error.code = "INVALID_SOLANA_CURRENT_AUTHORITY";
    throw error;
  }
  return authority;
}
