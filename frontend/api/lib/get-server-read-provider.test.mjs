import assert from "node:assert/strict";
import test from "node:test";

const original = { ...process.env };
process.env.ROBINHOOD_RPC_HTTP_46630 = "https://managed.example/rh-testnet-1,https://managed.example/rh-testnet-2";
process.env.ROBINHOOD_TESTNET_RPC_URL = "https://rpc.testnet.chain.robinhood.com";
process.env.VITE_PUBLIC_RPC_46630 = "https://frontend.example/rh-testnet";

const { getRpcUrls } = await import("./getServerReadProvider.js");

test("Robinhood testnet server RPC candidates prefer managed/local env before public fallback", () => {
  const urls = getRpcUrls(46630);
  assert.deepEqual(urls.slice(0, 4), [
    "https://managed.example/rh-testnet-1",
    "https://managed.example/rh-testnet-2",
    "https://frontend.example/rh-testnet",
    "https://rpc.testnet.chain.robinhood.com",
  ]);
  assert.equal(urls.filter((url) => url === "https://rpc.testnet.chain.robinhood.com").length, 1);
});

test("Robinhood mainnet is skipped when its RPC env is empty", () => {
  delete process.env.ROBINHOOD_RPC_HTTP_4663;
  delete process.env.ROBINHOOD_MAINNET_RPC_URL;
  delete process.env.ROBINHOOD_MAINNET_RPC;
  delete process.env.VITE_PUBLIC_RPC_4663;
  const urls = getRpcUrls(4663);
  assert.deepEqual(urls, []);
});

process.on("exit", () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) delete process.env[key];
  }
  Object.assign(process.env, original);
});
