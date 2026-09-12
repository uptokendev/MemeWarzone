import { arenaEnvironmentIdentity } from "./arenaChainEnvironment.js";

const LEGACY_SOLANA_CHAIN_ID = 102;
const CANONICAL_SOLANA_CHAIN_ID = 101;

function normalizeCluster(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "solana-mainnet-beta" || raw === "mainnet" || raw === "mainnetbeta") return "mainnet-beta";
  if (raw === "solana-devnet") return "devnet";
  return raw;
}

function runtimeEnvironment() {
  return String(
    process.env.SOLANA_REWARD_ENVIRONMENT ||
      process.env.RUNTIME_ENVIRONMENT ||
      process.env.VITE_RUNTIME_ENVIRONMENT ||
      "",
  ).trim().toLowerCase();
}

function runtimeCluster() {
  return normalizeCluster(
    process.env.SOLANA_REWARD_CLUSTER ||
      process.env.SOLANA_CLUSTER ||
      process.env.VITE_SOLANA_CLUSTER ||
      "",
  );
}

function identityError(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export function canonicalSolanaClaimIdentity({ chainId, environment = null, solanaCluster = null } = {}) {
  const numeric = Number(chainId);
  if (numeric === LEGACY_SOLANA_CHAIN_ID) {
    throw identityError(
      "LEGACY_SOLANA_CLAIM_CHAIN_RETIRED",
      "Solana claim chain 102 is retired. Use chain 101 with explicit staging/devnet or production/mainnet-beta identity.",
      400,
    );
  }
  if (numeric !== CANONICAL_SOLANA_CHAIN_ID) {
    throw identityError("SOLANA_CLAIM_CHAIN_INVALID", "Solana claims require canonical chain 101.", 400);
  }

  const requestedEnvironment = String(environment || "").trim().toLowerCase();
  const requestedCluster = normalizeCluster(solanaCluster);
  const configuredEnvironment = runtimeEnvironment();
  const configuredCluster = runtimeCluster();
  const effectiveEnvironment = requestedEnvironment || configuredEnvironment;
  const effectiveCluster = requestedCluster || configuredCluster;

  if (!effectiveEnvironment && !effectiveCluster) {
    throw identityError(
      "SOLANA_CLAIM_ENVIRONMENT_REQUIRED",
      "Solana claims require an explicit staging/devnet or production/mainnet-beta runtime identity.",
      503,
    );
  }

  let identity;
  try {
    identity = arenaEnvironmentIdentity(CANONICAL_SOLANA_CHAIN_ID, {
      environment: effectiveEnvironment || null,
      solanaCluster: effectiveCluster || null,
    });
  } catch (error) {
    throw identityError(error?.code || "INVALID_ENVIRONMENT", error?.message || "Invalid Solana claim environment identity.", 409);
  }

  if (!identity.environment || !identity.solanaCluster) {
    throw identityError("SOLANA_CLAIM_ENVIRONMENT_REQUIRED", "Solana claim environment identity is incomplete.", 503);
  }

  if (requestedEnvironment && configuredEnvironment && requestedEnvironment !== configuredEnvironment) {
    throw identityError("SOLANA_CLAIM_ENVIRONMENT_MISMATCH", "Requested Solana claim environment does not match this runtime.");
  }
  if (requestedCluster && configuredCluster && requestedCluster !== configuredCluster) {
    throw identityError("SOLANA_CLAIM_CLUSTER_MISMATCH", "Requested Solana cluster does not match this runtime.");
  }

  return identity;
}

export function solanaClaimIdentityFromMetadata(row, request = {}) {
  const metadata = row?.metadata && typeof row.metadata === "object"
    ? row.metadata
    : (() => {
        try { return JSON.parse(String(row?.metadata || "{}")); } catch { return {}; }
      })();
  const storedEnvironment = String(metadata?.environment || metadata?.runtimeEnvironment || metadata?.claimEnvironment || "").trim().toLowerCase();
  const storedCluster = normalizeCluster(metadata?.solanaCluster || metadata?.cluster || metadata?.claimCluster);
  const requestedEnvironment = String(request?.environment || "").trim().toLowerCase();
  const requestedCluster = normalizeCluster(request?.solanaCluster);

  if (storedEnvironment && requestedEnvironment && storedEnvironment !== requestedEnvironment) {
    throw identityError("SOLANA_ENTITLEMENT_ENVIRONMENT_MISMATCH", "Reward entitlement belongs to a different Solana environment.");
  }
  if (storedCluster && requestedCluster && storedCluster !== requestedCluster) {
    throw identityError("SOLANA_ENTITLEMENT_CLUSTER_MISMATCH", "Reward entitlement belongs to a different Solana cluster.");
  }

  return canonicalSolanaClaimIdentity({
    chainId: Number(row?.chain) || Number(metadata?.chainId) || request?.chainId,
    environment: storedEnvironment || requestedEnvironment || null,
    solanaCluster: storedCluster || requestedCluster || null,
  });
}

export function rejectLegacySolanaClaimChain(chainId) {
  if (Number(chainId) !== LEGACY_SOLANA_CHAIN_ID) return;
  throw identityError(
    "LEGACY_SOLANA_CLAIM_CHAIN_RETIRED",
    "Solana claim chain 102 is retired. Use chain 101 with an explicit environment identity.",
    400,
  );
}
