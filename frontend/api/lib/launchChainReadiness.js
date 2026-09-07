const ROBINHOOD_CHAINS = new Set([4663, 46630]);
const SOLANA_CHAINS = new Set([101, 102]);
const KNOWN_CHAINS = new Set([56, 97, 101, 102, 4663, 46630]);

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function explicitBoolean(env, keys, fallback) {
  for (const key of keys) {
    if (env[key] == null || String(env[key]).trim() === "") continue;
    return truthy(env[key]);
  }
  return fallback;
}

function first(env, keys) {
  for (const key of keys) {
    const value = String(env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function evmFactory(chainId, env) {
  const id = Number(chainId);
  const chainSpecific = first(env, [
    `FACTORY_ADDRESS_${id}`,
    `LAUNCH_FACTORY_ADDRESS_${id}`,
    `VITE_FACTORY_ADDRESS_${id}`,
  ]);
  if (chainSpecific) return chainSpecific;
  if (id === 56) return first(env, ["FACTORY_ADDRESS", "LAUNCH_FACTORY_ADDRESS", "VITE_FACTORY_ADDRESS"]);
  return "";
}

export function isSolanaLaunchChain(chainId) {
  return SOLANA_CHAINS.has(Number(chainId));
}

export function getLaunchChainReadiness(chainId, env = process.env) {
  const id = Number(chainId);
  const known = KNOWN_CHAINS.has(id);
  const supportEnabled = explicitBoolean(env, [`CHAIN_${id}_SUPPORT_ENABLED`, `SUPPORT_ENABLED_${id}`], known);
  const creationEnabled = explicitBoolean(env, [`CHAIN_${id}_CREATION_ENABLED`, `CREATION_ENABLED_${id}`], known && !ROBINHOOD_CHAINS.has(id));

  let runtimeReady = false;
  let runtimeKind = "unsupported";
  if (SOLANA_CHAINS.has(id)) {
    runtimeKind = "solana_program";
    runtimeReady = Boolean(
      truthy(env.SOLANA_CREATE_AUTH_ENABLED) &&
      first(env, ["SOLANA_RPC_URL"]) &&
      first(env, ["SOLANA_LAUNCHPAD_PROGRAM_ID"]) &&
      first(env, ["SOLANA_ROUTE_SIGNER_PUBLIC_KEY"]) &&
      first(env, ["SOLANA_ROUTE_SIGNER_SECRET_KEY"]) &&
      first(env, ["SOLANA_CLUSTER"]) &&
      first(env, ["SOLANA_CLUSTER_HASH_HEX"])
    );
  } else if (known) {
    runtimeKind = "evm_factory";
    runtimeReady = Boolean(evmFactory(id, env));
  }

  let reason = "ready";
  if (!known || !supportEnabled) reason = "support_disabled";
  else if (!creationEnabled) reason = "creation_disabled";
  else if (!runtimeReady) reason = SOLANA_CHAINS.has(id) ? "solana_runtime_missing" : "factory_missing";

  return {
    chainId: id,
    supportEnabled: Boolean(known && supportEnabled),
    creationEnabled: Boolean(creationEnabled),
    runtimeReady,
    runtimeKind,
    creationReady: Boolean(known && supportEnabled && creationEnabled && runtimeReady),
    reason,
  };
}
