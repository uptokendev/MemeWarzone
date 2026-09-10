const EVM_ENVIRONMENT_BY_CHAIN = Object.freeze({
  56: "production",
  97: "staging",
  4663: "production",
  46630: "staging",
});

export const ARENA_CHAIN_IDS = Object.freeze([56, 97, 101, 4663, 46630]);
const SUPPORTED = new Set(ARENA_CHAIN_IDS);

export function requiredArenaChainId(value, label = "Arena") {
  const chainId = Number(value);
  if (!Number.isSafeInteger(chainId) || !SUPPORTED.has(chainId)) {
    const error = new Error(`Unsupported ${label} chain id`);
    error.code = "INVALID_CHAIN";
    throw error;
  }
  return chainId;
}

export function arenaEnvironmentIdentity(chainId, { environment = null, solanaCluster = null } = {}) {
  const id = requiredArenaChainId(chainId);
  if (id === 101) {
    const env = String(environment || "").trim().toLowerCase();
    const cluster = String(solanaCluster || "").trim().toLowerCase();
    if (!env && !cluster) return { chainId: 101, environment: null, solanaCluster: null };
    if (env === "staging" || cluster === "devnet") {
      if ((env && env !== "staging") || (cluster && cluster !== "devnet")) {
        throw Object.assign(new Error("Solana staging requires devnet"), { code: "INVALID_ENVIRONMENT" });
      }
      return { chainId: 101, environment: "staging", solanaCluster: "devnet" };
    }
    if (env === "production" || cluster === "mainnet-beta") {
      if ((env && env !== "production") || (cluster && cluster !== "mainnet-beta")) {
        throw Object.assign(new Error("Solana production requires mainnet-beta"), { code: "INVALID_ENVIRONMENT" });
      }
      return { chainId: 101, environment: "production", solanaCluster: "mainnet-beta" };
    }
    throw Object.assign(new Error("Unsupported Solana environment identity"), { code: "INVALID_ENVIRONMENT" });
  }

  const expected = EVM_ENVIRONMENT_BY_CHAIN[id];
  const env = String(environment || "").trim().toLowerCase();
  if (env && env !== expected) {
    throw Object.assign(new Error(`Chain ${id} requires ${expected} environment`), { code: "INVALID_ENVIRONMENT" });
  }
  return { chainId: id, environment: expected, solanaCluster: null };
}
