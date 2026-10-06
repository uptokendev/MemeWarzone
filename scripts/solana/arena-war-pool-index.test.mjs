import assert from "node:assert/strict";
import test from "node:test";

import { evmRpcUrls, solanaRpcUrls } from "./arena-war-pool-index.mjs";

test("chain 101 never reads a devnet RPC; the public mainnet endpoint is the last resort", () => {
  const env = { SOLANA_RPC_URL: "https://api.devnet.solana.com,https://mainnet.helius-rpc.com/?k=x", SOLANA_MAINNET_RPC_HTTP: "https://rpc.example" };
  assert.deepEqual(solanaRpcUrls(101, env), ["https://rpc.example", "https://mainnet.helius-rpc.com/?k=x", "https://api.mainnet-beta.solana.com"]);
  assert.deepEqual(solanaRpcUrls(102, env), ["https://api.devnet.solana.com"]);
});

test("EVM RPCs come from the per-chain env names", () => {
  assert.deepEqual(evmRpcUrls(56, { ARENA_WAR_POOL_INDEX_RPC_56: "https://a, https://b", BSC_RPC_HTTP_56: "https://b" }), ["https://a", "https://b"]);
  assert.deepEqual(evmRpcUrls(4663, {}), []);
});
