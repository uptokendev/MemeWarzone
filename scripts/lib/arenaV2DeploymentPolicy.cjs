"use strict";

const path = require("node:path");

const ARENA_V2_CHAINS = Object.freeze({
  BSC_MAINNET: 56,
  BSC_TESTNET: 97,
  ROBINHOOD_MAINNET: 4663,
  ROBINHOOD_TESTNET: 46630,
  LOCAL: 31337,
});

const NETWORK_BY_CHAIN = Object.freeze({
  [ARENA_V2_CHAINS.BSC_MAINNET]: "bscMainnet",
  [ARENA_V2_CHAINS.BSC_TESTNET]: "bscTestnet",
  [ARENA_V2_CHAINS.ROBINHOOD_TESTNET]: "robinhoodTestnet",
  [ARENA_V2_CHAINS.LOCAL]: "hardhat",
});

function assertArenaV2DeploymentTarget(chainId, networkName, { allowLocal = false } = {}) {
  const id = Number(chainId);
  const name = String(networkName || "");

  if (id === ARENA_V2_CHAINS.ROBINHOOD_MAINNET) {
    throw new Error("Arena EVM V2 deployment on Robinhood mainnet 4663 is not activated by T2-PRE");
  }

  if (id === ARENA_V2_CHAINS.LOCAL) {
    if (!allowLocal) {
      throw new Error("Arena EVM V2 local deployment requires ARENA_V2_ALLOW_LOCAL=1");
    }
    if (name !== "hardhat" && name !== "localhost") {
      throw new Error(`Arena EVM V2 local chain 31337 requires hardhat/localhost network; got ${name}`);
    }
    return;
  }

  const expectedNetwork = NETWORK_BY_CHAIN[id];
  if (!expectedNetwork) {
    throw new Error(`Arena EVM V2 deployment is restricted to BSC 56/97 and Robinhood testnet 46630; got chain ${id}`);
  }
  if (name !== expectedNetwork) {
    throw new Error(`Arena EVM V2 chain ${id} must use Hardhat network ${expectedNetwork}; got ${name || "<empty>"}`);
  }
}

function envNamesFor(chainId, baseNames, { robinhoodStrict = true } = {}) {
  const id = Number(chainId);
  const bases = Array.isArray(baseNames) ? baseNames : [baseNames];
  if (id === ARENA_V2_CHAINS.ROBINHOOD_TESTNET && robinhoodStrict) {
    return bases.map((base) => `${base}_${id}`);
  }
  const names = [];
  for (const base of bases) names.push(`${base}_${id}`);
  for (const base of bases) names.push(base);
  return [...new Set(names)];
}

function defaultArenaV2DeploymentFile(chainId) {
  const id = Number(chainId);
  const suffix =
    id === ARENA_V2_CHAINS.BSC_MAINNET
      ? "bsc56"
      : id === ARENA_V2_CHAINS.BSC_TESTNET
        ? "bsc97"
        : id === ARENA_V2_CHAINS.ROBINHOOD_TESTNET
          ? "robinhood46630"
          : id === ARENA_V2_CHAINS.LOCAL
            ? "local31337"
            : `chain${id}`;
  return path.join("deployments", "arena", `war-pool-treasury-v2.${suffix}.json`);
}

module.exports = {
  ARENA_V2_CHAINS,
  NETWORK_BY_CHAIN,
  assertArenaV2DeploymentTarget,
  envNamesFor,
  defaultArenaV2DeploymentFile,
};
