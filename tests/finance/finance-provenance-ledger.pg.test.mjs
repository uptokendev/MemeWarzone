import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationPath = path.join(root, "db/migrations/20260914_000005_finance_provenance_ledger_v1.sql");

function migrationSql() {
  return fs.readFileSync(migrationPath, "utf8");
}

test("finance provenance migration creates canonical evidence and classifications", () => {
  const sql = migrationSql();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.finance_chain_evidence/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.finance_economic_classifications/);
  assert.match(sql, /deployment_generation text NOT NULL/);
  assert.match(sql, /decoder_version text NOT NULL/);
  assert.match(sql, /policy_version text NOT NULL/);
});

test("finance chain evidence has replay-safe deployment-aware identity", () => {
  const sql = migrationSql();
  assert.match(sql, /finance_chain_evidence_identity_uidx/);
  for (const field of [
    "chain_family",
    "chain_id",
    "network_key",
    "deployment_generation",
    "transaction_ref",
    "event_index",
    "inner_event_index",
    "source_event_type",
  ]) {
    assert.match(sql, new RegExp(`\\b${field}\\b`));
  }
  assert.match(sql, /chain_family <> 'evm' OR transaction_ref = lower\(transaction_ref\)/);
  assert.match(sql, /finalized_at >= occurred_at/);
});

test("finance classifications preserve accounting boundaries and quarantine unknown value", () => {
  const sql = migrationSql();
  for (const economicClass of [
    "protocol_revenue",
    "liability",
    "reserve",
    "restricted_allocation",
    "internal_transfer",
    "refund",
    "unknown",
  ]) {
    assert.match(sql, new RegExp(`'${economicClass}'`));
  }
  assert.match(sql, /economic_class <> 'unknown' OR recognition_status = 'quarantined'/);
  assert.match(sql, /finance_economic_classifications_component_uidx/);
  assert.match(sql, /supersedes_classification_id/);
});

test("finance provenance is append-only and backend-only", () => {
  const sql = migrationSql();
  assert.match(sql, /reject_finance_provenance_mutation/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON public\.finance_chain_evidence/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON public\.finance_economic_classifications/);
  assert.match(sql, /ALTER TABLE public\.finance_chain_evidence ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /ALTER TABLE public\.finance_economic_classifications ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.finance_chain_evidence FROM anon/);
  assert.match(sql, /REVOKE ALL ON TABLE public\.finance_economic_classifications FROM authenticated/);
  assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\.finance_chain_evidence TO service_role/);
  assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\.finance_economic_classifications TO service_role/);
});
