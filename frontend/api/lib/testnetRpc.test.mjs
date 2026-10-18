import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getRpcUrls } from "./getServerReadProvider.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const BSC97 = "https://bsc-testnet-rpc.publicnode.com";
const RH46630 = "https://rpc.testnet.chain.robinhood.com";

const TOUCHED = [
  "BSC_RPC_HTTP_56", "BSC_RPC_HTTP_97", "BSC_RPC_HTTP", "BSC_RPC_URL", "BNB_RPC_URL",
  "BSC_MAINNET_RPC", "BSC_MAINNET_RPC_URL", "BSC_TESTNET_RPC", "BSC_TESTNET_RPC_URL", "BSC_TESTNET_RPC_HTTP",
  "VITE_PUBLIC_RPC_56", "VITE_PUBLIC_RPC_97", "VITE_BSC_RPC_56", "VITE_BSC_RPC_97",
  "VITE_BSC_MAINNET_RPC", "VITE_PUBLIC_RPC_MAINNET", "VITE_BSC_TESTNET_RPC", "VITE_PUBLIC_RPC_TESTNET",
  "ROBINHOOD_RPC_HTTP_4663", "ROBINHOOD_RPC_HTTP_46630", "ROBINHOOD_MAINNET_RPC_URL", "ROBINHOOD_MAINNET_RPC",
  "ROBINHOOD_RPC_URL", "ROBINHOOD_TESTNET_RPC_URL", "ROBINHOOD_TESTNET_RPC",
  "VITE_PUBLIC_RPC_4663", "VITE_PUBLIC_RPC_46630", "RH_RPC_URL", "RPC_URL_4663",
  "EVM_GEN8_RPC_56", "EVM_GEN8_RPC_4663", "EVM_GEN8_RPC_97", "EVM_GEN8_RPC_46630",
  "SOLANA_RPC_HTTP", "SOLANA_RPC_URL", "SOLANA_RPC", "SOLANA_MAINNET_RPC", "SOLANA_MAINNET_RPC_URL",
  "SOLANA_MAINNET_RPC_HTTP", "VITE_SOLANA_RPC", "VITE_SOLANA_MAINNET_RPC", "VITE_PUBLIC_RPC_SOLANA",
  "VITE_PUBLIC_RPC_101", "VITE_SOLANA_RPC_URL", "SOLANA_REWARDS_RPC_URL",
];

function withRpcEnv(extra, fn) {
  const saved = new Map(TOUCHED.map((key) => [key, process.env[key]]));
  for (const key of TOUCHED) delete process.env[key];
  Object.assign(process.env, extra);
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("chain 97 and 46630 ignore mainnet RPC names", () => {
  withRpcEnv({
    BSC_RPC_HTTP_97: BSC97,
    ROBINHOOD_RPC_HTTP_46630: RH46630,
    BSC_RPC_HTTP: "https://bsc-mainnet.example",
    BSC_MAINNET_RPC_URL: "https://bsc-mainnet.example/paid",
    BSC_RPC_HTTP_56: "https://bsc-mainnet.example/56",
    ROBINHOOD_MAINNET_RPC_URL: "https://rh-mainnet.example",
    ROBINHOOD_RPC_HTTP_4663: "https://rh-mainnet.example/4663",
  }, () => {
    assert.deepEqual(getRpcUrls(97), [BSC97]);
    assert.deepEqual(getRpcUrls(46630), [RH46630]);
    assert.equal(getRpcUrls(97).some((url) => /dataseed|binance\.org|bsc-mainnet|rh-mainnet/i.test(url)), false);
    assert.equal(getRpcUrls(46630).some((url) => /rh-mainnet|bsc-mainnet/i.test(url)), false);
  });
});

test("empty mainnet RPC env is a skip, and an unset testnet uses the measured free RPC", () => {
  withRpcEnv({}, () => {
    assert.deepEqual(getRpcUrls(56), []);
    assert.deepEqual(getRpcUrls(4663), []);
    assert.deepEqual(getRpcUrls(97), [BSC97]);
    assert.deepEqual(getRpcUrls(46630), [RH46630]);
    assert.equal(getRpcUrls(97).some((url) => /dataseed|binance\.org/i.test(url)), false);
  });
});

test("a configured mainnet RPC stays first and keeps its public failover", () => {
  withRpcEnv({
    BSC_RPC_HTTP_56: "https://bsc-paid.example",
    ROBINHOOD_RPC_HTTP_4663: "https://rh-paid.example",
  }, () => {
    const bsc = getRpcUrls(56);
    const rh = getRpcUrls(4663);
    assert.equal(bsc[0], "https://bsc-paid.example");
    assert.ok(bsc.includes("https://bsc-dataseed.binance.org"));
    assert.equal(rh[0], "https://rh-paid.example");
    assert.ok(rh.includes("https://rpc.mainnet.chain.robinhood.com"));
  });
});

test("the app does not bake a mainnet RPC or the bnbchain dataseed", () => {
  const chainConfig = fs.readFileSync(path.join(root, "frontend/src/lib/chainConfig.ts"), "utf8");
  const wallet = fs.readFileSync(path.join(root, "frontend/src/lib/walletConnect.ts"), "utf8");
  for (const source of [chainConfig, wallet]) {
    assert.equal(source.includes("bsc-dataseed"), false, source.slice(0, 40));
    assert.equal(source.includes("data-seed-prebsc"), false);
    assert.equal(source.includes("rpc.mainnet.chain.robinhood.com"), false);
    assert.equal(source.includes("api.mainnet-beta.solana.com"), false);
  }
  assert.equal(chainConfig.includes(BSC97), true);
  assert.equal(chainConfig.includes(RH46630), true);
  assert.equal(wallet.includes(BSC97), true);
  assert.equal(wallet.includes(RH46630), true);
});
