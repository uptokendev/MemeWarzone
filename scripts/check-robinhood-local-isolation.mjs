#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildRobinhoodLocalEnv, isLoopbackHost } from "../frontend/scripts/robinhood-local-env.mjs";

const base = {
  DATABASE_URL: "postgresql://postgres:test@127.0.0.1:5432/memewarzone_robinhood_local",
  ROBINHOOD_TESTNET_RPC_URL: "https://rpc.testnet.chain.robinhood.com",

  // Simulate dangerous inherited production values. The builder must replace/scrub them.
  VITE_FRONTEND_API_BASE: "https://api.memewar.zone",
  VITE_TOKEN_API_BASE: "https://indexer.memewar.zone",
  VITE_REALTIME_API_BASE: "https://indexer.memewar.zone",
  RAILWAY_API_BASE_URL: "https://api.memewar.zone",
  RAILWAY_INDEXER_URL: "https://indexer.memewar.zone",
  ABLY_API_KEY: "production-key-must-not-survive",
  SUPABASE_URL: "https://production-project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "production-service-key-must-not-survive",
  TELEMETRY_INGEST_URL: "https://production-telemetry.example",
  BSC_RPC_HTTP_56: "https://production-bnb.example",
  BSC_RPC_HTTP_97: "https://test-bnb.example",
  SOLANA_RPC_HTTP: "https://production-solana.example",
};

const env = buildRobinhoodLocalEnv(base, {});

for (const key of [
  "VITE_FRONTEND_API_BASE",
  "VITE_TOKEN_API_BASE",
  "VITE_REALTIME_API_BASE",
  "VITE_API_BASE",
  "RAILWAY_API_BASE_URL",
  "RAILWAY_INDEXER_URL",
  "LOCAL_INDEXER_API_BASE_URL",
]) {
  const parsed = new URL(env[key]);
  assert.equal(isLoopbackHost(parsed.hostname), true, `${key} must resolve to loopback`);
}

assert.equal(env.RUNTIME_ENVIRONMENT, "local");
assert.equal(env.VITE_RUNTIME_ENVIRONMENT, "local");

// Browser remains product-parity capable: BNB | Solana | Robinhood.
assert.equal(env.VITE_ALLOWED_CHAIN_IDS, "56,101,46630");
assert.equal(env.VITE_DEFAULT_CHAIN_ID, "46630");

// Backend workers/indexers remain strictly Robinhood-only in this isolated profile.
assert.equal(env.DEFAULT_EVM_CHAIN_ID, "46630");
assert.equal(env.EVM_INDEXER_CHAIN_IDS, "46630");
assert.equal(env.BSC_RPC_HTTP_56, "");
assert.equal(env.BSC_RPC_HTTP_97, "");
assert.equal(env.SOLANA_RPC_HTTP, "");

assert.equal(env.LOCAL_DISABLE_ABLY, "1");
assert.equal(env.LOCAL_DISABLE_REMOTE_SUPABASE, "1");
assert.equal(env.ENABLE_DATA_URL_UPLOADS, "1");
assert.equal(env.ABLY_API_KEY, undefined);
assert.equal(env.SUPABASE_URL, undefined);
assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
assert.equal(env.TELEMETRY_INGEST_URL, "");

assert.throws(
  () =>
    buildRobinhoodLocalEnv(
      {
        DATABASE_URL: "postgresql://postgres:test@db.production.example:5432/memewarzone_robinhood_local",
        ROBINHOOD_TESTNET_RPC_URL: "https://rpc.testnet.chain.robinhood.com",
      },
      {},
    ),
  /loopback/i,
  "remote database must be rejected",
);

assert.throws(
  () =>
    buildRobinhoodLocalEnv(
      {
        DATABASE_URL: "postgresql://postgres:test@127.0.0.1:5432/memewarzone",
        ROBINHOOD_TESTNET_RPC_URL: "https://rpc.testnet.chain.robinhood.com",
      },
      {},
    ),
  /dedicated local Robinhood database/i,
  "shared local DB name must be rejected",
);

console.log("Robinhood local isolation proof passed.");
