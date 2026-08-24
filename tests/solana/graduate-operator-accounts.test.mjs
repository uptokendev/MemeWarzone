import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("operator graduate.mjs keeps feeEscrow on beginGraduation only", () => {
  const source = fs.readFileSync(path.join(root, "tools/solana-meteora-graduation/graduate.mjs"), "utf8");
  const begin = source.split("confirmGraduation")[0];
  const confirm = source.split("confirmGraduation")[1] || "";
  assert.match(begin, /feeEscrow:/);
  assert.doesNotMatch(confirm, /feeEscrow:/);
  assert.match(confirm, /remainingAccounts/);
  assert.match(confirm, /leagueVault/);
});

test("FeeEscrow worker uses a DB lease instead of session advisory locks", () => {
  const source = fs.readFileSync(path.join(root, "realtime-indexer/src/solanaFeeEscrowWorker.ts"), "utf8");
  const claimSql = fs.readFileSync(path.join(root, "realtime-indexer/src/solanaFeeEscrowClaimSql.ts"), "utf8");
  assert.match(source, /acquireLease/);
  assert.doesNotMatch(source, /pg_try_advisory_lock/);
  assert.match(source, /graduation_requested/);
  assert.match(source, /CLAIM_INIT_SQL/);
  assert.match(source, /CLAIM_FLUSH_SQL/);
  assert.match(source, /ACQUIRE_LEASE_SQL/);
  assert.match(source, /if \(!\(await acquireLease\(\)\)\) return;/);
  assert.match(claimSql, /solana_worker_leases/);
  assert.match(claimSql, /next_init_attempt_at = now\(\) \+ interval '60 seconds'/);
  assert.match(claimSql, /flush_status='submitted'/);
});
