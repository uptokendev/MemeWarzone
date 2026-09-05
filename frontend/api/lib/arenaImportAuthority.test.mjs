import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ARENA_IMPORT_SCAN_VERSION,
  FINDING_AUTHORITY,
  classifyFinding,
  classifyScan,
} from "./arenaImportScan.js";
import {
  evaluateImportedCompetitionEligibility,
  importedCreatorEconomicsAllowed,
} from "./arenaImportEligibility.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const adminSource = fs.readFileSync(path.resolve(here, "../admin/arenaImports.js"), "utf8");
const scannerSource = fs.readFileSync(path.resolve(here, "./arenaImportScan.js"), "utf8");
const migrationSource = [
  fs.readFileSync(path.resolve(here, "../../../db/migrations/20260905_000001_arena_import_authority.sql"), "utf8"),
  fs.readFileSync(path.resolve(here, "../../../db/migrations/20260905_000002_arena_import_initial_scan_history.sql"), "utf8"),
].join("\n");

const now = new Date("2026-09-05T12:00:00.000Z");
function row(overrides = {}) {
  const scan = {
    scanVersion: ARENA_IMPORT_SCAN_VERSION,
    scannedAt: "2026-09-05T11:00:00.000Z",
    findings: [],
  };
  return {
    id: "00000000-0000-0000-0000-000000000001",
    status: "passed",
    state_version: 4,
    scan_version: ARENA_IMPORT_SCAN_VERSION,
    scanned_at: scan.scannedAt,
    scan_json: scan,
    ...overrides,
  };
}

test("1 safe EVM import can classify passed", () => {
  assert.equal(classifyScan({ reasons: [], warnings: [] }).status, "passed");
});

test("2 safe external Solana import can pass without a MemeWarzone graduation pool", () => {
  assert.equal(classifyScan({ reasons: [], warnings: [] }).status, "passed");
  assert.equal(scannerSource.includes('warnings.push("no_meteora_pool")'), false);
  assert.match(scannerSource, /poolProvenance: "external_not_required"/);
});

test("3 reviewable uncertainty becomes needs_review", () => {
  assert.equal(classifyScan({ reasons: ["rpc_failed"], warnings: [] }).status, "needs_review");
  assert.equal(classifyFinding("rpc_failed").authority, FINDING_AUTHORITY.REVIEWABLE);
});

test("4 hard structural failure is non-overridable and admin approval blocks it", () => {
  assert.equal(classifyFinding("not_a_contract").authority, FINDING_AUTHORITY.NON_OVERRIDABLE);
  assert.equal(classifyFinding("not_a_mint").authority, FINDING_AUTHORITY.NON_OVERRIDABLE);
  assert.equal(classifyFinding("honeypot_sell_failed").authority, FINDING_AUTHORITY.NON_OVERRIDABLE);
  assert.equal(classifyFinding("non_transferable").authority, FINDING_AUTHORITY.NON_OVERRIDABLE);
  assert.match(adminSource, /decision === "approve" && hasNonOverridableFinding\(row\)/);
  assert.match(adminSource, /IMPORT_NON_OVERRIDABLE_FINDING/);
});

test("5 importer cannot self-approve", () => {
  assert.match(adminSource, /isSelfReview\(row, admin\)/);
  assert.match(adminSource, /IMPORT_SELF_REVIEW_FORBIDDEN/);
});

test("6 unauthenticated and non-admin callers cannot adjudicate", () => {
  assert.match(adminSource, /allowOps: false/);
  assert.match(adminSource, /admin\.mode !== "admin"/);
  assert.match(adminSource, /IMPORT_ADMIN_AUTH_REQUIRED/);
});

test("7 legacy-open compatibility cannot adjudicate imports", () => {
  assert.match(adminSource, /admin\.mode !== "admin"/);
  assert.equal(adminSource.includes('admin.mode === "legacy-open"'), false);
});

test("8 conflicting concurrent decisions are rejected by state-version CAS", () => {
  assert.match(adminSource, /for update/);
  assert.match(adminSource, /state_version = \$5/);
  assert.match(adminSource, /IMPORT_STATE_CONFLICT/);
  assert.match(adminSource, /idempotent: true/);
});

test("9 history is database-enforced append-only", () => {
  assert.match(migrationSource, /arena_token_import_history is append-only/);
  assert.match(migrationSource, /before update on public\.arena_token_import_history/);
  assert.match(migrationSource, /before delete on public\.arena_token_import_history/);
});

test("10 rescans are auditable", () => {
  assert.match(adminSource, /'rescan'/);
  assert.match(adminSource, /insert into public\.arena_token_import_history/);
  assert.match(migrationSource, /'scan'/);
});

test("11 stale approval fails canonical eligibility", () => {
  const stale = row({ scanned_at: "2026-08-01T00:00:00.000Z", scan_json: { scanVersion: ARENA_IMPORT_SCAN_VERSION, scannedAt: "2026-08-01T00:00:00.000Z", findings: [] } });
  const result = evaluateImportedCompetitionEligibility(stale, now);
  assert.equal(result.eligible, false);
  assert.equal(result.code, "IMPORT_SCAN_STALE");
  assert.equal(result.status, "stale");
});

test("12 later unsafe rescan revokes future eligibility", () => {
  const unsafe = row({ scan_json: { scanVersion: ARENA_IMPORT_SCAN_VERSION, scannedAt: "2026-09-05T11:00:00.000Z", findings: [{ code: "non_transferable", authority: FINDING_AUTHORITY.NON_OVERRIDABLE }] } });
  const result = evaluateImportedCompetitionEligibility(unsafe, now);
  assert.equal(result.eligible, false);
  assert.equal(result.code, "IMPORT_NON_OVERRIDABLE_FINDING");
});

test("13 fresh approved token passes canonical eligibility", () => {
  const result = evaluateImportedCompetitionEligibility(row(), now);
  assert.equal(result.eligible, true);
  assert.equal(result.code, "IMPORT_ELIGIBLE");
});

test("14 rejected token fails canonical eligibility", () => {
  const result = evaluateImportedCompetitionEligibility(row({ status: "declined" }), now);
  assert.equal(result.eligible, false);
  assert.equal(result.code, "IMPORT_REJECTED");
});

test("15 eligibility evaluation and rescan authority do not rewrite running competitions", () => {
  const original = row();
  const snapshot = structuredClone(original);
  evaluateImportedCompetitionEligibility(original, now);
  assert.deepEqual(original, snapshot);
  assert.equal(/update\s+public\.arena_battles/i.test(adminSource), false);
});

test("imported tokens never acquire native-launch creator economics", () => {
  assert.equal(importedCreatorEconomicsAllowed(), false);
});
