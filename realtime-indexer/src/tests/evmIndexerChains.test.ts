import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVE_EVM_INDEXER_CHAIN_IDS,
  KNOWN_EVM_INDEXER_CHAIN_IDS,
  buildActiveEvmIndexerChains,
  buildEvmIndexerChainConfig,
  isActiveEvmIndexerChainId,
  isKnownEvmIndexerChainId,
} from "../evmIndexerChains.js";

test("Robinhood EVM indexer chains are known but inactive during RH-3", () => {
  assert.deepEqual(KNOWN_EVM_INDEXER_CHAIN_IDS, [56, 97, 4663, 46630]);
  assert.deepEqual(ACTIVE_EVM_INDEXER_CHAIN_IDS, [56, 97]);
  assert.equal(isKnownEvmIndexerChainId(4663), true);
  assert.equal(isKnownEvmIndexerChainId(46630), true);
  assert.equal(isActiveEvmIndexerChainId(4663), false);
  assert.equal(isActiveEvmIndexerChainId(46630), false);
});

test("current BNB indexer chain shape is preserved", () => {
  const chains = buildActiveEvmIndexerChains({
    56: {
      rpcHttp: "https://rpc.example/56",
      factoryAddress: "0x1111111111111111111111111111111111111111",
      factoryStartBlock: 123,
      voteTreasuryAddress: "0x2222222222222222222222222222222222222222",
      voteTreasuryStartBlock: 456,
    },
    97: {
      rpcHttp: "https://rpc.example/97",
      factoryAddress: "0x3333333333333333333333333333333333333333",
    },
    4663: {
      rpcHttp: "https://rpc.mainnet.chain.robinhood.com",
    },
  });

  assert.deepEqual(chains.map((chain) => chain.chainId), [56, 97]);
  assert.equal(chains[0]?.factoryStartBlock, 123);
  assert.equal(chains[0]?.voteTreasuryStartBlock, 456);
});

test("an RPC alone never silently activates Robinhood", () => {
  const chains = buildActiveEvmIndexerChains({
    4663: { rpcHttp: "https://rpc.mainnet.chain.robinhood.com" },
    46630: { rpcHttp: "https://rpc.testnet.chain.robinhood.com" },
  });
  assert.deepEqual(chains, []);
});

test("future explicit activation is constructible without changing the core shape", () => {
  const chain = buildEvmIndexerChainConfig(46630, {
    rpcHttp: "https://rpc.testnet.chain.robinhood.com",
    factoryAddress: "0x4444444444444444444444444444444444444444",
    factoryStartBlock: 789,
  });

  assert.deepEqual(chain, {
    chainId: 46630,
    rpcHttp: "https://rpc.testnet.chain.robinhood.com",
    factoryAddress: "0x4444444444444444444444444444444444444444",
    factoryStartBlock: 789,
    voteTreasuryAddress: undefined,
    voteTreasuryStartBlock: undefined,
  });
});
