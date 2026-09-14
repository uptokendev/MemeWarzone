import assert from "node:assert/strict";
import test from "node:test";
import { selectPendingBnbBondingProtocolRevenue } from "./financeBondingRevenueBackfill.js";

function makeDb(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

test("selector queries only unposted BNB trade protocol revenue for the exact generation", async () => {
  const db = makeDb([{ id: 1 }]);
  const rows = await selectPendingBnbBondingProtocolRevenue(db, {
    chainId: 97,
    networkKey: "bsc-testnet",
    deploymentGeneration: "treasury-router-v3:testnet",
    expectedSourceContract: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    limit: 25,
  });

  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(db.calls.length, 1);
  const [{ sql, params }] = db.calls;
  assert.match(sql, /re\.route_kind = 'trade'/);
  assert.match(sql, /re\.protocol_amount > 0/);
  assert.match(sql, /re\.source_contract = \$2/);
  assert.match(sql, /NOT EXISTS/);
  assert.match(sql, /fce\.network_key = \$3/);
  assert.match(sql, /fce\.deployment_generation = \$4/);
  assert.match(sql, /fce\.transaction_ref = re\.tx_hash/);
  assert.match(sql, /fce\.event_index = re\.log_index/);
  assert.match(sql, /fce\.inner_event_index = -1/);
  assert.match(sql, /fce\.source_event_type = 'BondingTradeProtocolRevenue'/);
  assert.match(sql, /ORDER BY re\.block_number ASC, re\.log_index ASC, re\.id ASC/);
  assert.deepEqual(params, [
    97,
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bsc-testnet",
    "treasury-router-v3:testnet",
    25,
  ]);
});

test("selector rejects unsupported chains before querying", async () => {
  const db = makeDb();
  await assert.rejects(
    selectPendingBnbBondingProtocolRevenue(db, {
      chainId: 101,
      networkKey: "solana-devnet",
      deploymentGeneration: "generation-1",
      expectedSourceContract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    /only supports chain 56 or 97/,
  );
  assert.equal(db.calls.length, 0);
});

test("selector rejects an invalid Treasury routing source address", async () => {
  const db = makeDb();
  await assert.rejects(
    selectPendingBnbBondingProtocolRevenue(db, {
      chainId: 56,
      networkKey: "bnb-mainnet",
      deploymentGeneration: "generation-1",
      expectedSourceContract: "not-an-address",
    }),
    /expectedSourceContract must be an EVM address/,
  );
  assert.equal(db.calls.length, 0);
});

test("selector clamps batch size to a safe read-only range", async () => {
  const upper = makeDb();
  await selectPendingBnbBondingProtocolRevenue(upper, {
    chainId: 97,
    networkKey: "bsc-testnet",
    deploymentGeneration: "generation-1",
    expectedSourceContract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    limit: 5000,
  });
  assert.equal(upper.calls[0].params[4], 500);

  const lower = makeDb();
  await selectPendingBnbBondingProtocolRevenue(lower, {
    chainId: 97,
    networkKey: "bsc-testnet",
    deploymentGeneration: "generation-1",
    expectedSourceContract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    limit: 0,
  });
  assert.equal(lower.calls[0].params[4], 100);
});

test("selector is read-only and never posts Finance state", async () => {
  const db = makeDb();
  await selectPendingBnbBondingProtocolRevenue(db, {
    chainId: 97,
    networkKey: "bsc-testnet",
    deploymentGeneration: "generation-1",
    expectedSourceContract: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });

  const sql = db.calls[0].sql.trim().toUpperCase();
  assert.equal(sql.startsWith("SELECT"), true);
  assert.equal(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(sql), false);
});
