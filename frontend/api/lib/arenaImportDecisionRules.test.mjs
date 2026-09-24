import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { decideAdmissionStatus, hasAdminDecision, isFailedAdmissionScan } from "./arenaImportAdmission.js";

const passed = { status: "passed", scan: { reasons: [] } };
const review = { status: "needs_review", scan: { reasons: ["low_liquidity"] } };
const hard = { status: "declined", scan: { reasons: ["honeypot"] } };
const failed = { status: "needs_review", scan: { reasons: ["scan_failed"], error: "rpc down" } };

test("first scan decides; a failed first scan is needs_review", () => {
  assert.equal(decideAdmissionStatus({ status: "scanning" }, passed), "passed");
  assert.equal(decideAdmissionStatus({ status: "scanning" }, review), "needs_review");
  assert.equal(decideAdmissionStatus({ status: "scanning" }, hard), "declined");
  assert.equal(decideAdmissionStatus({ status: "scanning" }, failed), "needs_review");
});

test("a manual approval survives every scheduled rescan except a hard failure", () => {
  const approved = { status: "passed", reviewed_at: "2026-09-24T20:00:00Z" };
  assert.equal(hasAdminDecision(approved), true);
  assert.equal(decideAdmissionStatus(approved, review), "passed", "the reviewer already overrode this finding");
  assert.equal(decideAdmissionStatus(approved, passed), "passed");
  assert.equal(decideAdmissionStatus(approved, hard), "declined", "no reviewer may override a non-overridable finding");
});

test("a manual decline sticks; an automatic status follows the scan", () => {
  const declined = { status: "declined", reviewed_at: "2026-09-24T20:00:00Z" };
  assert.equal(decideAdmissionStatus(declined, passed), "declined");
  assert.equal(decideAdmissionStatus({ status: "passed" }, review), "needs_review");
  assert.equal(decideAdmissionStatus({ status: "needs_review" }, passed), "passed");
});

test("a failed scan never overwrites a decided row (write nothing, go stale honestly)", () => {
  assert.equal(isFailedAdmissionScan(failed), true);
  assert.equal(decideAdmissionStatus({ status: "passed" }, failed), null);
  assert.equal(decideAdmissionStatus({ status: "passed", reviewed_at: "x" }, failed), null);
});

test("admin approve rescans first and stores the fresh evidence; CrypticPump listing resolves the verified import owner", () => {
  const admin = fs.readFileSync(new URL("../admin/arenaImports.js", import.meta.url), "utf8");
  assert.match(admin, /freshScan = await scanToken\(/);
  assert.match(admin, /hasNonOverridableFinding\(\{ scan_json: freshScan\?\.scan \|\| \{\} \}\)/);
  assert.match(admin, /scanned_at = \$8::timestamptz/);
  const listing = fs.readFileSync(new URL("../crypticpump-listings.js", import.meta.url), "utf8");
  assert.match(listing, /from public\.arena_token_imports[\s\S]*ownership_status = 'ownership_verified'/);
});
