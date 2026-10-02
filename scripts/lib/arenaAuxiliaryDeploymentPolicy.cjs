"use strict";

const path = require("node:path");

const ARENA_AUX_CHAINS = Object.freeze({
  BSC_MAINNET: 56,
  BSC_TESTNET: 97,
  ROBINHOOD_MAINNET: 4663,
  ROBINHOOD_TESTNET: 46630,
  LOCAL: 31337,
});

const NETWORK_BY_CHAIN = Object.freeze({
  [ARENA_AUX_CHAINS.BSC_MAINNET]: "bscMainnet",
  [ARENA_AUX_CHAINS.BSC_TESTNET]: "bscTestnet",
  [ARENA_AUX_CHAINS.ROBINHOOD_MAINNET]: "robinhoodMainnet",
  [ARENA_AUX_CHAINS.ROBINHOOD_TESTNET]: "robinhoodTestnet",
  [ARENA_AUX_CHAINS.LOCAL]: "hardhat",
});

function assertArenaAuxiliaryTarget(chainId, networkName, { allowLocal = false } = {}) {
  const id = Number(chainId);
  const name = String(networkName || "");

  if (id === ARENA_AUX_CHAINS.LOCAL) {
    if (!allowLocal) throw new Error("Arena auxiliary local deployment requires ARENA_AUX_ALLOW_LOCAL=1");
    if (name !== "hardhat" && name !== "localhost") {
      throw new Error(`Arena auxiliary local chain 31337 requires hardhat/localhost network; got ${name}`);
    }
    return;
  }

  const expected = NETWORK_BY_CHAIN[id];
  if (!expected) {
    throw new Error(`Arena auxiliary deployment is restricted to BSC 56/97 and Robinhood 4663/46630; got chain ${id}`);
  }
  if (name !== expected) {
    throw new Error(`Arena auxiliary chain ${id} must use Hardhat network ${expected}; got ${name || "<empty>"}`);
  }
}

function envNameFor(chainId, base) {
  const id = Number(chainId);
  if (id === ARENA_AUX_CHAINS.LOCAL) return String(base);
  return `${base}_${id}`;
}

function confirmTokenFor(chainId) {
  return `DEPLOY_ARENA_AUX_${Number(chainId)}`;
}

function defaultArenaAuxiliaryFile(chainId) {
  const id = Number(chainId);
  const suffix =
    id === ARENA_AUX_CHAINS.BSC_MAINNET
      ? "bsc56"
      : id === ARENA_AUX_CHAINS.BSC_TESTNET
        ? "bsc97"
        : id === ARENA_AUX_CHAINS.ROBINHOOD_MAINNET
          ? "robinhood4663"
          : id === ARENA_AUX_CHAINS.ROBINHOOD_TESTNET
            ? "robinhood46630"
            : id === ARENA_AUX_CHAINS.LOCAL
              ? "local31337"
              : `chain${id}`;
  return path.join("deployments", "arena", `auxiliary-bundle.${suffix}.json`);
}

module.exports = {
  ARENA_AUX_CHAINS,
  NETWORK_BY_CHAIN,
  assertArenaAuxiliaryTarget,
  envNameFor,
  confirmTokenFor,
  defaultArenaAuxiliaryFile,
};
