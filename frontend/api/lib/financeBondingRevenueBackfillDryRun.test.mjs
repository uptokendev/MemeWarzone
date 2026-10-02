import assert from "node:assert/strict";
import test from "node:test";
import { dryRunBnbBondingProtocolRevenueBackfill } from "./financeBondingRevenueBackfillDryRun.js";

const SOURCE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TX = `0x${"b".repeat(64)}`;

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

function validRow(overrides = {}) {
  return {
    id: 7,
    chain_id: 97,
    tx_hash: TX,
    log_index: 3,
    block_number: "123456",
    occurred_at: "2026-09-14T10:00:00.000Z",
    route_kind: "trade",
    route_profile: "standard_linked",
    protocol_amount: "5000000000000000",
    raw_amount: "1000000000000000000",
    source_contract: SOURCE,
    source_event: "RouteExecuted",
    campaign_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    matched_activity_source: "trade",
    ...overrides,
  };
}

function options(overrides = {}) {
  return {
    chainId: 97,
    networkKey: "bsc-testnet",
    deploymentGeneration: "treasury-router-v3:testnet",
    expectedSourceContract: SOURCE,
    decoderVersion: "reward-events-v1",
    policyVersion: "bnb-bonding-protocol-revenue-v1",
    finalizedAt: "2026-09-14T10:05:00.000Z",
    limit: 25,
    ...overrides,
  };
}

test("dry run previews eligible rows without writing Finance state", async () => {
  const db = makeDb([validRow()]);
  const report = await dryRunBnbBondingProtocolRevenueBackfill(db, options());

  assert.equal(report.mode, "dry-run");
  assert.equal(report.selected, 1);
  assert.equal(report.eligible, 1);
  assert.equal(report.invalid, 0);
  assert.deepEqual(report.items, [{
    rewardEventId: 7,
    status: "eligible",
    transactionRef: TX,
    eventIndex: 3,
    protocolAmountRaw: "5000000000000000",
    economicLane: "bonding_curve_fee",
  }]);

  assert.equal(db.calls.length, 1);
  const sql = db.calls[0].sql.trim().toUpperCase();
  assert.equal(sql.startsWith("SELECT"), true);
  assert.equal(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(sql), false);
});

test("dry run reports invalid rows without aborting the batch", async () => {
  const db = makeDb([
    validRow({ id: 1 }),
    validRow({ id: 2, tx_hash: "not-a-tx-hash" }),
    validRow({ id: 3, tx_hash: `0x${"c".repeat(64)}`, protocol_amount: "42" }),
  ]);

  const report = await dryRunBnbBondingProtocolRevenueBackfill(db, options());
  assert.equal(report.selected, 3);
  assert.equal(report.eligible, 2);
  assert.equal(report.invalid, 1);
  assert.equal(report.items[0].status, "eligible");
  assert.equal(report.items[1].status, "invalid");
  assert.match(report.items[1].error, /tx_hash must be a 32-byte EVM transaction hash/);
  assert.equal(report.items[2].status, "eligible");
});

test("dry run passes chain, source, generation and limit to the read-only selector", async () => {
  const db = makeDb([]);
  const report = await dryRunBnbBondingProtocolRevenueBackfill(db, options({
    chainId: 56,
    networkKey: "bnb-mainnet",
    deploymentGeneration: "treasury-router-v3:mainnet",
    expectedSourceContract: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    limit: 9999,
  }));

  assert.equal(report.chainId, 56);
  assert.equal(report.networkKey, "bnb-mainnet");
  assert.equal(report.deploymentGeneration, "treasury-router-v3:mainnet");
  assert.deepEqual(db.calls[0].params, [
    56,
    "0xcccccccccccccccccccccccccccccccccccccccc",
    "bnb-mainnet",
    "treasury-router-v3:mainnet",
    500,
  ]);
});

test("dry run rejects unsupported chain before querying", async () => {
  const db = makeDb([]);
  await assert.rejects(
    dryRunBnbBondingProtocolRevenueBackfill(db, options({ chainId: 101 })),
    /only supports chain 56 or 97/,
  );
  assert.equal(db.calls.length, 0);
});
