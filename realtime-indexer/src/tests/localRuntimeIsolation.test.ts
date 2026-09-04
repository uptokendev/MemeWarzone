import assert from "node:assert/strict";
import test from "node:test";

process.env.RUNTIME_ENVIRONMENT = "local";
process.env.VITE_RUNTIME_ENVIRONMENT = "local";
process.env.DATABASE_URL = "postgresql://postgres:test@127.0.0.1:5432/memewarzone_robinhood_local";
process.env.LOCAL_DISABLE_ABLY = "1";
process.env.ROBINHOOD_TESTNET_RPC_URL = "https://rpc.testnet.chain.robinhood.com";
process.env.DEFAULT_EVM_CHAIN_ID = "46630";
process.env.EVM_INDEXER_CHAIN_IDS = "46630";
process.env.TELEMETRY_INGEST_URL = "";
delete process.env.ABLY_API_KEY;

const { ENV } = await import("../env.js");

test("isolated local runtime boots without Ably and keeps Robinhood config explicit", () => {
  assert.equal(ENV.ABLY_DISABLED, true);
  assert.equal(ENV.ABLY_API_KEY, "");
  assert.equal(ENV.DEFAULT_EVM_CHAIN_ID, 46630);
  assert.deepEqual(ENV.EVM_INDEXER_CHAIN_IDS, [46630]);
  assert.equal(ENV.ROBINHOOD_RPC_HTTP_46630, "https://rpc.testnet.chain.robinhood.com");
  assert.equal(ENV.TELEMETRY_INGEST_URL, "");
  assert.equal(ENV.TELEMETRY_TOKEN, "");
});
