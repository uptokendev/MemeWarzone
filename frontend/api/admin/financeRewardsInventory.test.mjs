import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { apiSolanaCluster, financeInventory, rewardChainCandidates, rewardsNotice } = await import("./finance.js");

function fakeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const mainnet = { chainId: 101, chain: "solana", decimals: 9, asset: "SOL", environment: "production", cluster: "mainnet-beta" };
const devnet = { chainId: 101, chain: "solana", decimals: 9, asset: "SOL", environment: "staging", cluster: "devnet" };

function withCluster(value, fn) {
  const saved = [process.env.SOLANA_CLUSTER, process.env.VITE_SOLANA_CLUSTER];
  if (value == null) delete process.env.SOLANA_CLUSTER; else process.env.SOLANA_CLUSTER = value;
  delete process.env.VITE_SOLANA_CLUSTER;
  try { return fn(); } finally {
    if (saved[0] == null) delete process.env.SOLANA_CLUSTER; else process.env.SOLANA_CLUSTER = saved[0];
    if (saved[1] == null) delete process.env.VITE_SOLANA_CLUSTER; else process.env.VITE_SOLANA_CLUSTER = saved[1];
  }
}

test("API cluster defaults to mainnet-beta and accepts the chain-registry spelling", () => {
  withCluster(null, () => assert.equal(apiSolanaCluster(), "mainnet-beta"));
  withCluster("solana-devnet", () => assert.equal(apiSolanaCluster(), "devnet"));
});

test("live API (mainnet): chain 101 mainnet rows are read; legacy 102 never; devnet reads nothing", () => {
  withCluster("mainnet-beta", () => {
    const candidates = rewardChainCandidates(mainnet);
    assert.ok(candidates.includes("101"));
    assert.ok(!candidates.includes("102"));
    assert.deepEqual(rewardChainCandidates(devnet), []);
    assert.equal(rewardsNotice(mainnet), null);
    assert.match(rewardsNotice(devnet), /production database/);
  });
});

test("test API (devnet): devnet rows are read, mainnet reads nothing", () => {
  withCluster("devnet", () => {
    assert.deepEqual(rewardChainCandidates(devnet), ["101", "solana-devnet"]);
    assert.deepEqual(rewardChainCandidates(mainnet), []);
    assert.match(rewardsNotice(mainnet), /test database/);
  });
});

test("BNB candidates are the chain id only", () => {
  assert.deepEqual(rewardChainCandidates({ chainId: 56, chain: "bnb" }), ["56"]);
});

test("inventory adds a balance to each item through the injected reader", async () => {
  const saved = process.env.FACTORY_ADDRESS_56;
  process.env.FACTORY_ADDRESS_56 = "0x00000000000000000000000000000000000000f1";
  try {
    const res = fakeRes();
    const balances = async (items) => items.map((item) => ({ ...item, balance: { status: "unknown", amount: null, raw: null, asset: "BNB", decimals: 18 } }));
    await financeInventory({ query: {} }, res, { chainId: 56, chain: "bnb", decimals: 18, asset: "BNB", environment: "mainnet" }, { balances });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.schemaVersion, "finance-inventory-v1");
    const factory = res.body.items.find((item) => item.id === "bnb56-factory");
    assert.ok(factory);
    assert.equal(factory.balance.status, "unknown");
    assert.equal(factory.balance.amount, null);
  } finally {
    if (saved == null) delete process.env.FACTORY_ADDRESS_56; else process.env.FACTORY_ADDRESS_56 = saved;
  }
});
