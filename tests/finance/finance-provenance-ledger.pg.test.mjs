import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationPath = path.join(root, "db/migrations/20260914_000005_finance_provenance_ledger_v1.sql");
const databaseUrl = String(process.env.FINANCE_PROVENANCE_TEST_DATABASE_URL || "").trim();
const pgSkip = !databaseUrl;

function migrationSql() {
  return fs.readFileSync(migrationPath, "utf8");
}

function transactionalMigrationSql() {
  return migrationSql()
    .replace(/^\s*BEGIN;\s*/i, "")
    .replace(/\s*COMMIT;\s*$/i, "");
}

function assertLocalTestDatabase(url) {
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1", "postgres"].includes(parsed.hostname)) {
    throw new Error("Finance provenance PostgreSQL tests require an isolated localhost/Postgres service, never production");
  }
}

async function expectPgError(client, sql, params, expectedCode) {
  await client.query("SAVEPOINT finance_expected_error");
  try {
    await assert.rejects(
      client.query(sql, params),
      (error) => error?.code === expectedCode,
    );
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT finance_expected_error");
    await client.query("RELEASE SAVEPOINT finance_expected_error");
  }
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

test("PostgreSQL enforces replay, immutability, supersession, and unknown quarantine", { skip: pgSkip }, async () => {
  assertLocalTestDatabase(databaseUrl);
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(transactionalMigrationSql());

    const evidenceInsert = `
      INSERT INTO public.finance_chain_evidence (
        chain_family, chain_id, network_key, deployment_generation,
        source_system, source_event_type, source_primary_key,
        transaction_ref, block_or_slot, event_index, inner_event_index,
        decoder_version, asset_symbol, asset_address_or_mint,
        gross_amount_raw, occurred_at, finalized_at, metadata
      ) VALUES (
        'evm', 97, 'bsc-testnet', 'finance-test-generation',
        'finance_test', 'ProtocolFeeObserved', 'source-1',
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        12345, 7, -1, 'decoder-test-v1', 'BNB', NULL,
        1000, '2026-09-14T10:00:00Z', '2026-09-14T10:00:01Z', '{}'::jsonb
      )
      RETURNING id
    `;

    const evidence = await client.query(evidenceInsert);
    const evidenceId = evidence.rows[0].id;

    await expectPgError(client, evidenceInsert, [], "23505");

    await expectPgError(
      client,
      "UPDATE public.finance_chain_evidence SET gross_amount_raw = 999 WHERE id = $1",
      [evidenceId],
      "55000",
    );
    await expectPgError(
      client,
      "DELETE FROM public.finance_chain_evidence WHERE id = $1",
      [evidenceId],
      "55000",
    );

    await expectPgError(
      client,
      `INSERT INTO public.finance_economic_classifications (
         evidence_id, classification_version, component_key, economic_class,
         economic_lane, amount_raw, recognition_status, reconciliation_status,
         policy_version
       ) VALUES ($1, 1, 'protocol', 'unknown', 'unmapped', 1000, 'pending', 'unreconciled', 'policy-test-v1')`,
      [evidenceId],
      "23514",
    );

    const firstClassification = await client.query(
      `INSERT INTO public.finance_economic_classifications (
         evidence_id, classification_version, component_key, economic_class,
         economic_lane, amount_raw, recognition_status, reconciliation_status,
         policy_version, classification_reason
       ) VALUES ($1, 1, 'protocol', 'unknown', 'unmapped', 1000, 'quarantined', 'unreconciled', 'policy-test-v1', 'initially unmapped')
       RETURNING id`,
      [evidenceId],
    );
    const firstClassificationId = firstClassification.rows[0].id;

    const replacement = await client.query(
      `INSERT INTO public.finance_economic_classifications (
         evidence_id, classification_version, component_key, economic_class,
         economic_lane, amount_raw, recognition_status, reconciliation_status,
         policy_version, supersedes_classification_id, classification_reason
       ) VALUES ($1, 2, 'protocol', 'protocol_revenue', 'protocol_fee', 1000, 'recognized', 'matched', 'policy-test-v2', $2, 'classification corrected without rewriting history')
       RETURNING id, supersedes_classification_id`,
      [evidenceId, firstClassificationId],
    );

    assert.ok(replacement.rows[0].id);
    assert.equal(replacement.rows[0].supersedes_classification_id, firstClassificationId);

    await expectPgError(
      client,
      "UPDATE public.finance_economic_classifications SET classification_reason = 'rewritten' WHERE id = $1",
      [firstClassificationId],
      "55000",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    await client.end().catch(() => {});
  }
});
