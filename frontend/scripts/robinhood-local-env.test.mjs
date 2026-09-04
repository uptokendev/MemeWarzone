import assert from "node:assert/strict";
import test from "node:test";

import { buildRobinhoodLocalEnv } from "./robinhood-local-env.mjs";

const base = {
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/memewarzone_robinhood_local",
  ROBINHOOD_TESTNET_RPC_URL: "https://rpc.testnet.chain.robinhood.com",
};

test("Robinhood localhost exposes BNB Solana Robinhood while backend remains 46630-only", () => {
  const env = buildRobinhoodLocalEnv(base, {});

  assert.equal(env.VITE_ALLOWED_CHAIN_IDS, "56,101,46630");
  assert.equal(env.VITE_DEFAULT_CHAIN_ID, "46630");
  assert.equal(env.DEFAULT_EVM_CHAIN_ID, "46630");
  assert.equal(env.EVM_INDEXER_CHAIN_IDS, "46630");
  assert.equal(env.ENABLE_ROBINHOOD_V3_POOL_INDEXER, "1");
  assert.equal(env.ENABLE_TOPAZ_POOL_INDEXER, "0");
  assert.equal(env.BSC_RPC_HTTP_56, "");
  assert.equal(env.BSC_RPC_HTTP_97, "");
  assert.equal(env.SOLANA_RPC_HTTP, "");
});

test("Robinhood localhost overrides stale two-chain browser activation", () => {
  const env = buildRobinhoodLocalEnv(base, { VITE_ALLOWED_CHAIN_IDS: "56,101" });
  assert.equal(env.VITE_ALLOWED_CHAIN_IDS, "56,101,46630");
});

test("Robinhood route authority key is normalized for shared EVM API signing", () => {
  const env = buildRobinhoodLocalEnv(base, {
    ROBINHOOD_ROUTE_AUTHORITY_PRIVATE_KEY: "0x1234",
  });
  assert.equal(env.ROUTE_AUTHORITY_PRIVATE_KEY, "0x1234");
});
