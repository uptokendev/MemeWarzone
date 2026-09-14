import assert from "node:assert/strict";
import test from "node:test";
import {
  FinanceEvidenceReplayMismatchError,
  normalizeFinanceEvidence,
  recordFinanceChainEvidence,
} from "./financeProvenance.js";

function baseInput(overrides = {}) {
  return {
    chainFamily: "evm",
    chainId: 97,
    networkKey: "bsc-testnet",
    deploymentGeneration: "generation-test-v1",
    sourceSystem: "finance-test",
    sourceEventType: "ProtocolFeeObserved",
    sourcePrimaryKey: "source-1",
    transactionRef: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    blockOrSlot: "12345",
    eventIndex: 7,
    innerEventIndex: -1,
    decoderVersion: "decoder-v1",
    assetSymbol: "BNB",
    assetAddressOrMint: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    grossAmountRaw: "1000",
    occurredAt: "2026-09-14T10:00:00Z",
    finalizedAt: "2026-09-14T10:00:01Z",
    metadata: { source: "test" },
    ...overrides,
  };
}

function storedRow(input = baseInput()) {
  const normalized = normalizeFinanceEvidence(input);
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ...normalized,
    chain_id: String(normalized.chain_id),
    block_or_slot: normalized.block_or_slot,
    gross_amount_raw: normalized.gross_amount_raw,
    occurred_at: new Date(normalized.occurred_at),
    finalized_at: new Date(normalized.finalized_at),
  };
}

test("normalizeFinanceEvidence preserves integer amounts and canonicalizes EVM refs", () => {
  const normalized = normalizeFinanceEvidence(baseInput());
  assert.equal(normalized.transaction_ref, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(normalized.asset_address_or_mint, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(normalized.gross_amount_raw, "1000");
  assert.equal(normalized.block_or_slot, "12345");
  assert.equal(normalized.event_index, 7);
});

test("recordFinanceChainEvidence returns newly inserted evidence", async () => {
  const row = storedRow();
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [row] };
    },
  };

  const result = await recordFinanceChainEvidence(db, baseInput());
  assert.equal(result.replayed, false);
  assert.equal(result.evidence.id, row.id);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT/);
  assert.match(calls[0].sql, /DO NOTHING/);
});

test("recordFinanceChainEvidence returns identical canonical row on replay", async () => {
  const row = storedRow();
  let call = 0;
  const db = {
    async query() {
      call += 1;
      return call === 1 ? { rows: [] } : { rows: [row] };
    },
  };

  const result = await recordFinanceChainEvidence(db, baseInput());
  assert.equal(result.replayed, true);
  assert.equal(result.evidence.id, row.id);
  assert.equal(call, 2);
});

test("recordFinanceChainEvidence rejects replay whose immutable amount differs", async () => {
  const row = storedRow(baseInput({ grossAmountRaw: "999" }));
  let call = 0;
  const db = {
    async query() {
      call += 1;
      return call === 1 ? { rows: [] } : { rows: [row] };
    },
  };

  await assert.rejects(
    recordFinanceChainEvidence(db, baseInput()),
    (error) => error instanceof FinanceEvidenceReplayMismatchError
      && error.code === "FINANCE_EVIDENCE_REPLAY_MISMATCH"
      && /gross_amount_raw/.test(error.message),
  );
});

test("normalizeFinanceEvidence rejects floats, invalid finality, and unknown chain families", () => {
  assert.throws(() => normalizeFinanceEvidence(baseInput({ grossAmountRaw: 1.5 })), /grossAmountRaw/);
  assert.throws(
    () => normalizeFinanceEvidence(baseInput({ finalizedAt: "2026-09-14T09:59:59Z" })),
    /finalizedAt must be at or after occurredAt/,
  );
  assert.throws(() => normalizeFinanceEvidence(baseInput({ chainFamily: "tron" })), /chainFamily/);
});
