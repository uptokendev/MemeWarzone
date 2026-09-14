import assert from "node:assert/strict";
import test from "node:test";
import { postFinanceEconomicEvent } from "./financePosting.js";

function postingInput(overrides = {}) {
  return {
    evidence: {
      chainFamily: "evm",
      chainId: 97,
      networkKey: "bsc-testnet",
      deploymentGeneration: "generation-test-v1",
      sourceSystem: "finance-test",
      sourceEventType: "CompetitionEntryObserved",
      sourcePrimaryKey: "battle:test-1",
      transactionRef: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      blockOrSlot: "12345",
      eventIndex: 2,
      innerEventIndex: -1,
      decoderVersion: "decoder-v1",
      assetSymbol: "BNB",
      grossAmountRaw: "100",
      occurredAt: "2026-09-14T10:00:00Z",
      finalizedAt: "2026-09-14T10:00:01Z",
      metadata: { source: "test" },
    },
    classifications: [
      {
        classificationVersion: 1,
        componentKey: "prize",
        economicClass: "liability",
        economicLane: "competition_prize",
        amountRaw: "75",
        recognitionStatus: "recognized",
        reconciliationStatus: "unreconciled",
        policyVersion: "test-policy-v1",
      },
      {
        classificationVersion: 1,
        componentKey: "league",
        economicClass: "reserve",
        economicLane: "post_grad_league",
        amountRaw: "20",
        recognitionStatus: "recognized",
        reconciliationStatus: "unreconciled",
        policyVersion: "test-policy-v1",
      },
      {
        classificationVersion: 1,
        componentKey: "protocol",
        economicClass: "protocol_revenue",
        economicLane: "competition_protocol",
        amountRaw: "5",
        recognitionStatus: "recognized",
        reconciliationStatus: "unreconciled",
        policyVersion: "test-policy-v1",
      },
    ],
    ...overrides,
  };
}

function makeClient({ failClassification = false } = {}) {
  const calls = [];
  let classificationInsertCount = 0;
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (/INSERT INTO public\.finance_chain_evidence/.test(sql)) {
        return { rows: [{ id: "11111111-1111-4111-8111-111111111111" }] };
      }
      if (/INSERT INTO public\.finance_economic_classifications/.test(sql)) {
        classificationInsertCount += 1;
        if (failClassification && classificationInsertCount === 2) {
          const error = new Error("classification failed");
          error.code = "TEST_CLASSIFICATION_FAILURE";
          throw error;
        }
        return {
          rows: [{
            id: `22222222-2222-4222-8222-${String(classificationInsertCount).padStart(12, "0")}`,
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
      throw new Error(`Unexpected SQL in financePosting test: ${sql}`);
    },
    release() {
      calls.push({ sql: "RELEASE" });
    },
  };
  return { client, calls };
}

test("postFinanceEconomicEvent commits evidence and all classifications atomically", async () => {
  const { client, calls } = makeClient();
  const pool = { async connect() { return client; } };

  const result = await postFinanceEconomicEvent(pool, postingInput());

  assert.equal(result.evidence.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(result.classifications.length, 3);
  assert.deepEqual(result.classificationReplayed, [false, false, false]);
  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.at(-2).sql, "COMMIT");
  assert.equal(calls.at(-1).sql, "RELEASE");
  assert.equal(calls.some((call) => call.sql === "ROLLBACK"), false);
});

test("postFinanceEconomicEvent rolls back the whole posting if one classification fails", async () => {
  const { client, calls } = makeClient({ failClassification: true });
  const pool = { async connect() { return client; } };

  await assert.rejects(
    postFinanceEconomicEvent(pool, postingInput()),
    (error) => error?.code === "TEST_CLASSIFICATION_FAILURE",
  );

  assert.equal(calls[0].sql, "BEGIN");
  assert.equal(calls.some((call) => call.sql === "COMMIT"), false);
  assert.equal(calls.at(-2).sql, "ROLLBACK");
  assert.equal(calls.at(-1).sql, "RELEASE");
});

test("postFinanceEconomicEvent validates the whole posting before opening a transaction", async () => {
  let connected = false;
  const pool = {
    async connect() {
      connected = true;
      throw new Error("should not connect");
    },
  };

  await assert.rejects(
    postFinanceEconomicEvent(pool, postingInput({ classifications: [] })),
    /classifications must contain at least one/,
  );
  assert.equal(connected, false);
});
