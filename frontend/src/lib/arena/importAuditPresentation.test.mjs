import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canRequestImportManualReview,
  importAuditPresentation,
  presentImportScanCode,
  presentImportScanFindings,
} from "./importAuditPresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const detailsSource = fs.readFileSync(path.join(here, "../../pages/ImportedTokenDetails.tsx"), "utf8");
const clientSource = fs.readFileSync(path.join(here, "../arenaImports.ts"), "utf8");

function item(overrides = {}) {
  return {
    id: "import-1",
    chainId: 56,
    ownerWallet: "0xAbC0000000000000000000000000000000000000",
    status: "needs_review",
    reviewRequestedAt: null,
    ...overrides,
  };
}

test("passed import presentation accurately describes only the implemented automatic checks", () => {
  const result = importAuditPresentation("passed");
  assert.equal(result.title, "AUTOMATIC CHECK PASSED");
  assert.match(result.description, /automatic checks currently implemented/i);
  assert.match(result.description, /not a guarantee/i);
  assert.doesNotMatch(result.description, /rug proof|100% safe|audited safe/i);
});

test("needs_review and declined presentations use the required outcomes", () => {
  assert.equal(importAuditPresentation("needs_review").title, "AUTOMATIC CHECK NEEDS REVIEW");
  assert.equal(importAuditPresentation("declined").title, "AUTOMATIC CHECK FAILED");
});

test("known scan reasons are human-readable and severity is not recomputed", () => {
  const findings = presentImportScanFindings({
    reasons: ["honeypot_sell_failed", "paused"],
    warnings: ["owner_present", "topaz_buy_quote_failed", "paused"],
  });
  assert.deepEqual(findings.map((finding) => finding.code), [
    "honeypot_sell_failed",
    "paused",
    "owner_present",
    "topaz_buy_quote_failed",
  ]);
  assert.match(findings[0].message, /Topaz/i);
  assert.match(findings[1].message, /paused/i);
});

test("unknown future scan reasons remain visible without exposing exception detail", () => {
  const finding = presentImportScanCode("future_scanner_signal");
  assert.equal(finding.known, false);
  assert.equal(finding.code, "future_scanner_signal");
  assert.match(finding.message, /future scanner signal/i);
  const findings = presentImportScanFindings({
    reasons: ["future_scanner_signal"],
    detail: "SECRET_RPC_URL internal stack trace",
  });
  assert.equal(findings.length, 1);
  assert.doesNotMatch(findings[0].message, /SECRET_RPC_URL|stack trace/);
});

test("authorized EVM owner can request a manual check and unrelated wallet cannot", () => {
  assert.equal(canRequestImportManualReview(item(), "0xabc0000000000000000000000000000000000000", false), true);
  assert.equal(canRequestImportManualReview(item(), "0xdef0000000000000000000000000000000000000", false), false);
});

test("Solana owner matching remains case-sensitive", () => {
  const solItem = item({ chainId: 101, ownerWallet: "AbCdEfSolanaOwner", status: "declined" });
  assert.equal(canRequestImportManualReview(solItem, "AbCdEfSolanaOwner", true), true);
  assert.equal(canRequestImportManualReview(solItem, "abcdefsolanaowner", true), false);
});

test("already-requested and passed imports do not expose a fresh request action", () => {
  assert.equal(canRequestImportManualReview(item({ reviewRequestedAt: "2026-09-05T13:00:00.000Z" }), item().ownerWallet, false), false);
  assert.equal(canRequestImportManualReview(item({ status: "passed" }), item().ownerWallet, false), false);
});

test("details page wires the existing signed review request and transitions to returned backend item", () => {
  assert.match(detailsSource, /action: "arena_import_request_review"/);
  assert.match(detailsSource, /extraLines: \[`Import: \$\{currentItem\.id\}`\]/);
  assert.match(detailsSource, /requestArenaImportReview\(currentItem\.id, auth, reviewReason\.trim\(\) \|\| undefined\)/);
  assert.match(detailsSource, /setCurrentItem\(next\)/);
  assert.match(detailsSource, /MANUAL REVIEW REQUESTED/);
  assert.match(detailsSource, /formatReviewTimestamp\(currentItem\.reviewRequestedAt\)/);
  assert.match(detailsSource, /currentItem\.reviewReason/);
  assert.match(detailsSource, /maxLength=\{500\}/);
});

test("client forwards only the existing auth and optional reason contract", () => {
  assert.match(clientSource, /\/request-review/);
  assert.match(clientSource, /JSON\.stringify\(\{ auth, reason \}\)/);
  assert.doesNotMatch(clientSource, /approved|approveImport|status:\s*["']passed["']/i);
});

test("frontend does not manufacture passed and existing UpVote and Trading gates stay status-driven", () => {
  assert.doesNotMatch(detailsSource, /setCurrentItem\([^\n]*status\s*:\s*["']passed["']/i);
  assert.doesNotMatch(detailsSource, /requestArenaImportReview[^\n]*passed/i);
  const passedGates = detailsSource.match(/currentItem\.status === "passed"/g) || [];
  assert.equal(passedGates.length, 3);
  assert.match(detailsSource, /<ArenaUpvoteDialog/);
  assert.match(detailsSource, /<ImportedTradePanel item=\{currentItem\}/);
});
