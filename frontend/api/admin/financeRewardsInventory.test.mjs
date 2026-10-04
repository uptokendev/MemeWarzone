import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";

const { apiSolanaCluster, financeInventory, inventoryFromFeeRouting, rewardChainCandidates, rewardFundingFromFeeRouting, rewardsNotice } = await import("./finance.js");

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

test("inventory lists the fee-routing destinations with their balances; no env needed", async () => {
  const feeRouting = {
    destinations: [
      { id: "protocol_vault", label: "Protocol vault (PDA)", kind: "pda", address: "BvQHb6qq22ZHAVUpXaaeizBaRhGpuu5T3i8Y3ebZ2que", role: "Protocol share", ownership: "ours", flags: [], balances: [{ asset: "SOL", status: "ok", amount: "0.5", raw: "500000000", amountUsd: 60, source: "rpc:x" }] },
      { id: "lp_protocol_treasury", label: "LP-fee protocol treasury", kind: "wallet", address: "BvQHb6qq22ZHAVUpXaaeizBaRhGpuu5T3i8Y3ebZ2que", ownership: "ours", flags: [], balances: [{ asset: "SOL", status: "ok", amount: "0.5", raw: "500000000" }] },
      { id: "dbc_fee_collector", label: "Meteora DBC fee collector", kind: "wallet", address: null, ownership: "owed", flags: [], balances: [{ asset: "SOL", status: "not_configured", amount: null, error: "DBC_FEE_COLLECTOR is not set on this API." }] },
      { id: "creator_fee_vaults", label: "Creator fee vaults", kind: "pda-set", address: null, flags: [], balances: [] },
      { id: "deployer", label: "Deployer (watch only)", kind: "wallet", address: "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H", ownership: "watch", flags: ["watch"], balances: [{ asset: "SOL", status: "unknown", amount: null, error: "rpc down" }] },
    ],
    totals: { holdings: { byChain: [], amountUsd: 60, pricedCount: 1, missingPriceCount: 0, unknownAmountCount: 0 } },
    prices: [{ asset: "SOL", priceUsd: 120 }],
  };
  const { items, missing } = inventoryFromFeeRouting(mainnet, feeRouting);
  assert.deepEqual(items.map((i) => i.id), ["101-protocol_vault", "101-deployer"], "same address once, pda-set and unset addresses not listed as items");
  assert.equal(items[0].kind, "vault");
  assert.equal(items[0].kindLabel, "program account");
  assert.equal(items[0].balance.status, "ok");
  assert.equal(items[1].watchOnly, true);
  assert.equal(items[1].balance.status, "unknown");
  assert.equal(items[1].balance.amount, null, "an unread balance is never 0");
  assert.deepEqual(missing, [{ id: "dbc_fee_collector", label: "Meteora DBC fee collector", note: "DBC_FEE_COLLECTOR is not set on this API." }]);
  const res = fakeRes();
  await financeInventory({ query: {} }, res, mainnet, { feeRouting, prices: { spotTable: async () => [] } });
  assert.equal(res.body.schemaVersion, "finance-inventory-v1");
  assert.equal(res.body.addressSource, "fee-routing");
  assert.equal(res.body.totals.amountUsd, 60, "inventory total is Held now");
});

test("reward funding is the airdrop vault on the fee-routing map, never an env list", () => {
  const sol = rewardFundingFromFeeRouting(mainnet, { destinations: [{ id: "airdrop_vault", label: "Airdrop vault", address: "BE9ubLmT1M1N976ABCc9DpYo4iaeRJ4DHEXLCksrGQk4", balances: [{ asset: "SOL", status: "ok", raw: "273479887" }] }] });
  assert.equal(sol.readable, true);
  assert.equal(sol.fundedRaw, 273479887n);
  const rh = rewardFundingFromFeeRouting({ chainId: 4663, chain: "robinhood", asset: "ETH", decimals: 18 }, { destinations: [{ id: "airdrop_distributor", label: "Airdrop distributor", address: "0x2ABd8970680d806e46DeD9AEdDAA6E12d866641D", balances: [{ asset: "ETH", status: "unknown", error: "rpc down" }] }] });
  assert.equal(rh.configured, true);
  assert.equal(rh.readable, false);
  assert.match(rh.error, /rpc down/);
  assert.equal(rewardFundingFromFeeRouting(mainnet, { destinations: [] }).configured, false);
});
