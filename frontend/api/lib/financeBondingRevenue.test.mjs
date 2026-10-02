import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBnbBondingProtocolRevenuePosting,
  postBnbBondingProtocolRevenue,
} from "./financeBondingRevenue.js";

function rewardEvent(overrides = {}) {
  return {
    id: 42,
    chain_id: 97,
    tx_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    log_index: 7,
    block_number: "12345",
    occurred_at: "2026-09-14T10:00:00Z",
    route_kind: "trade",
    route_profile: "standard_linked",
    protocol_amount: "5000000000000000",
    raw_amount: "100000000000000000",
    source_contract: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    source_event: "RouteExecuted",
    campaign_address: "0xcccccccccccccccccccccccccccccccccccccccc",
    matched_activity_source: "curve_trade",
    ...overrides,
  };
}

function options(overrides = {}) {
  return {
    networkKey: "bsc-testnet",
    deploymentGeneration: "treasury-router-current-test-generation",
    decoderVersion: "reward-events-v1",
    policyVersion: "finance-bonding-protocol-v1",
    expectedSourceContract: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    finalizedAt: "2026-09-14T10:00:05Z",
    ...overrides,
  };
}

test("buildBnbBondingProtocolRevenuePosting maps only authoritative protocol_amount as protocol revenue", () => {
  const posting = buildBnbBondingProtocolRevenuePosting(rewardEvent(), options());

  assert.equal(posting.evidence.chainFamily, "evm");
  assert.equal(posting.evidence.chainId, 97);
  assert.equal(posting.evidence.transactionRef, rewardEvent().tx_hash);
  assert.equal(posting.evidence.eventIndex, 7);
  assert.equal(posting.evidence.grossAmountRaw, "5000000000000000");
  assert.equal(posting.evidence.metadata.rawRouteAmount, "100000000000000000");
  assert.equal(posting.classifications.length, 1);
  assert.equal(posting.classifications[0].economicClass, "protocol_revenue");
  assert.equal(posting.classifications[0].economicLane, "bonding_curve_fee");
  assert.equal(posting.classifications[0].amountRaw, "5000000000000000");
});

test("adapter rejects finalize rows, zero protocol revenue, wrong chains, and wrong source contract", () => {
  assert.throws(
    () => buildBnbBondingProtocolRevenuePosting(rewardEvent({ route_kind: "finalize" }), options()),
    /route_kind = trade/,
  );
  assert.throws(
    () => buildBnbBondingProtocolRevenuePosting(rewardEvent({ protocol_amount: "0" }), options()),
    /protocol_amount > 0/,
  );
  assert.throws(
    () => buildBnbBondingProtocolRevenuePosting(rewardEvent({ chain_id: 1 }), options()),
    /only supports chain 56 or 97/,
  );
  assert.throws(
    () => buildBnbBondingProtocolRevenuePosting(
      rewardEvent({ source_contract: "0xdddddddddddddddddddddddddddddddddddddddd" }),
      options(),
    ),
    /does not match the configured Treasury routing authority/,
  );
});

test("adapter requires explicit finality and preserves chain/deployment provenance", () => {
  assert.throws(
    () => buildBnbBondingProtocolRevenuePosting(rewardEvent(), options({ finalizedAt: undefined })),
    /finalizedAt/,
  );

  const posting = buildBnbBondingProtocolRevenuePosting(rewardEvent(), options());
  assert.equal(posting.evidence.networkKey, "bsc-testnet");
  assert.equal(posting.evidence.deploymentGeneration, "treasury-router-current-test-generation");
  assert.equal(posting.evidence.decoderVersion, "reward-events-v1");
  assert.equal(posting.classifications[0].policyVersion, "finance-bonding-protocol-v1");
});

test("postBnbBondingProtocolRevenue posts through the atomic Finance transaction primitive", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (/INSERT INTO public\.finance_chain_evidence/.test(sql)) {
        return {
          rows: [{
            id: "11111111-1111-4111-8111-111111111111",
            chain_family: "evm",
            chain_id: 97,
            network_key: "bsc-testnet",
            deployment_generation: "treasury-router-current-test-generation",
            source_system: "reward_events",
            source_event_type: "BondingTradeProtocolRevenue",
            source_primary_key: "reward_events:42",
            transaction_ref: rewardEvent().tx_hash,
            block_or_slot: "12345",
            event_index: 7,
            inner_event_index: -1,
            decoder_version: "reward-events-v1",
            asset_symbol: "BNB",
            asset_address_or_mint: null,
            gross_amount_raw: "5000000000000000",
            occurred_at: new Date("2026-09-14T10:00:00Z"),
            finalized_at: new Date("2026-09-14T10:00:05Z"),
          }],
        };
      }
      if (/INSERT INTO public\.finance_economic_classifications/.test(sql)) {
        return {
          rows: [{
            id: "22222222-2222-4222-8222-222222222222",
            evidence_id: params[0],
            classification_version: params[1],
            component_key: params[2],
            economic_class: params[3],
            economic_lane: params[4],
            amount_raw: params[5],
            recognition_status: params[6],
            reconciliation_status: params[7],
            policy_version: params[8],
            supersedes_classification_id: params[9],
            classification_reason: params[10],
          }],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {
      calls.push({ sql: "RELEASE" });
    },
  };
  const pool = { async connect() { return client; } };

  const result = await postBnbBondingProtocolRevenue(pool, rewardEvent(), options());
  assert.equal(result.evidence.gross_amount_raw, "5000000000000000");
  assert.equal(result.classifications[0].economic_class, "protocol_revenue");
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(calls.at(-1).sql, "RELEASE");
});
