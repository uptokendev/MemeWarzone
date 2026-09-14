import assert from "node:assert/strict";
import test from "node:test";
import {
  FinanceClassificationReplayMismatchError,
  normalizeFinanceClassification,
  recordFinanceEconomicClassification,
} from "./financeClassification.js";

function baseInput(overrides = {}) {
  return {
    evidenceId: "11111111-1111-4111-8111-111111111111",
    classificationVersion: 1,
    componentKey: "protocol",
    economicClass: "protocol_revenue",
    economicLane: "protocol_fee",
    amountRaw: "1000",
    recognitionStatus: "recognized",
    reconciliationStatus: "matched",
    policyVersion: "policy-test-v1",
    supersedesClassificationId: null,
    classificationReason: "test posting",
    metadata: { source: "test" },
    ...overrides,
  };
}

function storedRow(input = baseInput()) {
  const normalized = normalizeFinanceClassification(input);
  return {
    id: "22222222-2222-4222-8222-222222222222",
    ...normalized,
    classification_version: String(normalized.classification_version),
  };
}

test("normalizeFinanceClassification preserves raw integer amount", () => {
  const normalized = normalizeFinanceClassification(baseInput());
  assert.equal(normalized.amount_raw, "1000");
  assert.equal(normalized.classification_version, 1);
});

test("recordFinanceEconomicClassification returns new row", async () => {
  const row = storedRow();
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [row] };
    },
  };

  const result = await recordFinanceEconomicClassification(db, baseInput());
  assert.equal(result.replayed, false);
  assert.equal(result.classification.id, row.id);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT \(evidence_id, classification_version, component_key\) DO NOTHING/);
});

test("recordFinanceEconomicClassification returns identical row on replay", async () => {
  const row = storedRow();
  let call = 0;
  const db = {
    async query() {
      call += 1;
      return call === 1 ? { rows: [] } : { rows: [row] };
    },
  };

  const result = await recordFinanceEconomicClassification(db, baseInput());
  assert.equal(result.replayed, true);
  assert.equal(result.classification.id, row.id);
  assert.equal(call, 2);
});

test("recordFinanceEconomicClassification rejects conflicting replay", async () => {
  const row = storedRow(baseInput({ amountRaw: "999" }));
  let call = 0;
  const db = {
    async query() {
      call += 1;
      return call === 1 ? { rows: [] } : { rows: [row] };
    },
  };

  await assert.rejects(
    recordFinanceEconomicClassification(db, baseInput()),
    (error) => error instanceof FinanceClassificationReplayMismatchError
      && error.code === "FINANCE_CLASSIFICATION_REPLAY_MISMATCH"
      && /amount_raw/.test(error.message),
  );
});

test("unknown classification must be quarantined", () => {
  assert.throws(
    () => normalizeFinanceClassification(baseInput({ economicClass: "unknown", recognitionStatus: "pending" })),
    /must remain quarantined/,
  );

  const normalized = normalizeFinanceClassification(baseInput({
    economicClass: "unknown",
    economicLane: "unmapped",
    recognitionStatus: "quarantined",
  }));
  assert.equal(normalized.recognition_status, "quarantined");
});

test("superseding classification preserves previous row identity", () => {
  const priorId = "33333333-3333-4333-8333-333333333333";
  const normalized = normalizeFinanceClassification(baseInput({
    classificationVersion: 2,
    supersedesClassificationId: priorId,
    classificationReason: "corrected mapping",
  }));
  assert.equal(normalized.classification_version, 2);
  assert.equal(normalized.supersedes_classification_id, priorId);
});

test("normalization rejects floats, invalid versions, and unsupported classes", () => {
  assert.throws(() => normalizeFinanceClassification(baseInput({ amountRaw: 1.5 })), /amountRaw/);
  assert.throws(() => normalizeFinanceClassification(baseInput({ classificationVersion: 0 })), /classificationVersion/);
  assert.throws(() => normalizeFinanceClassification(baseInput({ economicClass: "expense" })), /economicClass is unsupported/);
});
