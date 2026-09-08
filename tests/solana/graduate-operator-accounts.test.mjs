import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("operator graduate.mjs atomically flushes FeeEscrow before signed graduation", () => {
  const source = fs.readFileSync(path.join(root, "tools/solana-meteora-graduation/graduate.mjs"), "utf8");
  const flushStart = source.indexOf(".flushCampaignFees()");
  const beginStart = source.indexOf(".beginGraduation(");
  const confirmStart = source.indexOf(".confirmGraduation()");
  const instructionListStart = source.indexOf("const instructions = [");

  assert.ok(flushStart >= 0, "graduate.mjs must build flushCampaignFees");
  assert.ok(beginStart > flushStart, "beginGraduation must be built after the fee flush instruction");
  assert.ok(confirmStart > beginStart, "confirmGraduation must be built after beginGraduation");
  assert.ok(instructionListStart > confirmStart, "graduation instruction list must be assembled after confirmGraduation");

  const flush = source.slice(flushStart, beginStart);
  const begin = source.slice(beginStart, confirmStart);
  const confirm = source.slice(confirmStart, instructionListStart);
  const instructionList = source.slice(instructionListStart, source.indexOf("const latest =", instructionListStart));

  assert.match(flush, /\bfeeEscrow\s*,/);
  for (const vault of [
    "weeklyLeagueVault",
    "airdropVault",
    "monthlyLeagueVault",
    "recruiterVault",
    "squadVault",
    "protocolVault",
  ]) {
    assert.match(flush, new RegExp(`\\b${vault}\\s*:`), `flushCampaignFees must include ${vault}`);
  }

  assert.match(begin, /\bfeeEscrow\s*,/);
  assert.doesNotMatch(confirm, /\bfeeEscrow\b/);
  assert.match(confirm, /remainingAccounts/);
  assert.match(confirm, /leagueVault/);

  assert.match(
    instructionList,
    /flushFeesIx\s*,\s*ed25519Ix[\s\S]*?beginIx\s*,/,
    "atomic graduation must order flush -> Ed25519 -> beginGraduation",
  );
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
