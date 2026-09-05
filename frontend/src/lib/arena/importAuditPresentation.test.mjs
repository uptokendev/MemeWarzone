import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canRequestImportManualReview,
  importAuditPresentation,
  presentImportCompetitionEligibility,
  presentImportScanCode,
  presentImportScanFindings,
} from "./importAuditPresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const detailsSource = fs.readFileSync(path.join(here, "../../pages/ImportedTokenDetails.tsx"), "utf8");
const clientSource = fs.readFileSync(path.join(here, "../arenaImports.ts"), "utf8");
const helperSource = fs.readFileSync(path.join(here, "./importAuditPresentation.mjs"), "utf8");

function eligibility(authorityOutcome = "needs_review", eligible = false, overrides = {}) {
  return {
    eligible,
    code: eligible ? "IMPORT_ELIGIBLE" : "IMPORT_REVIEW_REQUIRED",
    status: authorityOutcome === "rejected" ? "declined" : authorityOutcome,
    authorityOutcome,
    freshness: { fresh: authorityOutcome !== "stale", stale: authorityOutcome === "stale" },
    ...overrides,
  };
}

function item(overrides = {}) {
  return {
    id: "import-1",
    chainId: 56,
    ownerWallet: "0xAbC0000000000000000000000000000000000000",
    status: "needs_review",
    eligibility: eligibility("needs_review", false),
    reviewRequestedAt: null,
    ...overrides,
  };
}

test("safe automatic audit renders from canonical current authority", () => {
  const result = importAuditPresentation(item({ status: "passed", eligibility: eligibility("passed", true) }));
  assert.equal(result.title, "AUTOMATIC CHECK PASSED");
  assert.match(result.description, /backend reports a current approved/i);
  assert.match(result.description, /not a guarantee/i);
  assert.equal(presentImportCompetitionEligibility(item({ status: "passed", eligibility: eligibility("passed", true) })).eligible, true);
});

test("needs_review renders as non-eligible review authority", () => {
  const target = item();
  assert.equal(importAuditPresentation(target).title, "AUTOMATIC CHECK NEEDS REVIEW");
  assert.equal(presentImportCompetitionEligibility(target).eligible, false);
  assert.equal(presentImportCompetitionEligibility(target).authorityOutcome, "needs_review");
});

test("hard_failure renders as non-approved authority even if persisted status is passed", () => {
  const target = item({ status: "passed", eligibility: eligibility("hard_failure", false, { code: "IMPORT_NON_OVERRIDABLE_FINDING" }) });
  assert.equal(importAuditPresentation(target).title, "AUTOMATIC CHECK HARD FAILURE");
  assert.equal(presentImportCompetitionEligibility(target).eligible, false);
  assert.equal(presentImportCompetitionEligibility(target).label, "HARD FAILURE");
});

test("stale canonical authority never appears competitively eligible", () => {
  const target = item({ status: "passed", eligibility: eligibility("stale", false, { code: "IMPORT_SCAN_STALE" }) });
  const result = presentImportCompetitionEligibility(target);
  assert.equal(result.eligible, false);
  assert.equal(result.authorityOutcome, "stale");
  assert.equal(importAuditPresentation(target).title, "AUTOMATIC CHECK STALE");
});

test("rejected and not-approved authority never appear eligible", () => {
  for (const authorityOutcome of ["rejected", "not_approved"]) {
    const target = item({ status: "passed", eligibility: eligibility(authorityOutcome, false) });
    assert.equal(presentImportCompetitionEligibility(target).eligible, false);
    assert.equal(importAuditPresentation(target).title, "IMPORT NOT APPROVED");
  }
  const missingAuthority = item({ status: "passed", eligibility: null });
  assert.equal(presentImportCompetitionEligibility(missingAuthority).eligible, false);
  assert.equal(presentImportCompetitionEligibility(missingAuthority).authorityOutcome, "not_approved");
});

test("known and unknown scan reason codes stay safe human-readable display only", () => {
  const findings = presentImportScanFindings({
    reasons: ["honeypot_sell_failed", "paused", "future_scanner_signal"],
    warnings: ["owner_present", "topaz_buy_quote_failed", "paused"],
    detail: "SECRET_RPC_URL internal stack trace",
  });
  assert.deepEqual(findings.map((finding) => finding.code), [
    "honeypot_sell_failed",
    "paused",
    "future_scanner_signal",
    "owner_present",
    "topaz_buy_quote_failed",
  ]);
  const future = presentImportScanCode("future_scanner_signal");
  assert.equal(future.known, false);
  assert.match(future.message, /future scanner signal/i);
  assert.doesNotMatch(future.message, /SECRET_RPC_URL|stack trace/);
});

test("only the stored import owner can request review", () => {
  assert.equal(canRequestImportManualReview(item(), "0xabc0000000000000000000000000000000000000", false), true);
  assert.equal(canRequestImportManualReview(item(), "0xdef0000000000000000000000000000000000000", false), false);
  const solItem = item({ chainId: 101, ownerWallet: "AbCdEfSolanaOwner", status: "declined", eligibility: eligibility("rejected", false) });
  assert.equal(canRequestImportManualReview(solItem, "AbCdEfSolanaOwner", true), true);
  assert.equal(canRequestImportManualReview(solItem, "abcdefsolanaowner", true), false);
  assert.equal(canRequestImportManualReview(item({ reviewRequestedAt: "2026-09-05T13:00:00.000Z" }), item().ownerWallet, false), false);
  assert.equal(canRequestImportManualReview(item({ status: "passed" }), item().ownerWallet, false), false);
});

test("successful review request wiring shows returned timestamp and note", () => {
  assert.match(detailsSource, /action: "arena_import_request_review"/);
  assert.match(detailsSource, /extraLines: \[`Import: \$\{currentItem\.id\}`\]/);
  assert.match(detailsSource, /requestArenaImportReview\(currentItem\.id, auth, reviewReason\.trim\(\) \|\| undefined\)/);
  assert.match(detailsSource, /setCurrentItem\(next\)/);
  assert.match(detailsSource, /MANUAL REVIEW REQUESTED/);
  assert.match(detailsSource, /formatReviewTimestamp\(currentItem\.reviewRequestedAt\)/);
  assert.match(detailsSource, /currentItem\.reviewReason/);
  assert.match(detailsSource, /maxLength=\{500\}/);
});

test("public UI cannot approve reject or rescan and client only posts request-review auth", () => {
  assert.match(clientSource, /\/request-review/);
  assert.match(clientSource, /JSON\.stringify\(\{ auth, reason \}\)/);
  for (const source of [detailsSource, clientSource]) {
    assert.doesNotMatch(source, /\/api\/admin\/arena\/imports/);
    assert.doesNotMatch(source, /\/approve(?:["'`/]|\b)/i);
    assert.doesNotMatch(source, /\/reject(?:["'`/]|\b)/i);
    assert.doesNotMatch(source, /\/rescan(?:["'`/]|\b)/i);
    assert.doesNotMatch(source, /service[_-]?role|SUPABASE_SERVICE/i);
  }
});

test("frontend does not reconstruct scanner severity or hard/reviewable decisions", () => {
  assert.doesNotMatch(helperSource, /NON_OVERRIDABLE|REVIEWABLE/);
  assert.doesNotMatch(helperSource, /scan\??\.(?:authority|severity|hardBlocked)/);
  assert.doesNotMatch(helperSource, /honeypot_sell_failed[\s\S]{0,120}authorityOutcome/);
  assert.match(helperSource, /item\?\.eligibility\?\.authorityOutcome/);
});

test("new competition authority never relies on persisted status passed alone", () => {
  const stalePassed = item({ status: "passed", eligibility: eligibility("stale", false) });
  assert.equal(presentImportCompetitionEligibility(stalePassed).eligible, false);
  assert.match(detailsSource, /data-import-competition-eligibility/);
  assert.match(detailsSource, /presentImportCompetitionEligibility\(currentItem\)/);
  const passedGates = detailsSource.match(/currentItem\.status === "passed"/g) || [];
  assert.equal(passedGates.length, 3);
  assert.match(detailsSource, /<ArenaUpvoteDialog/);
  assert.match(detailsSource, /<ImportedTradePanel item=\{currentItem\}/);
  assert.doesNotMatch(detailsSource, /competition[^\n]{0,120}currentItem\.status === "passed"/i);
});

test("native MemeWarzone campaign architecture is unaffected", () => {
  assert.doesNotMatch(detailsSource, /fetchCampaign|campaigns\/|nativeExists|graduation/i);
  assert.doesNotMatch(helperSource, /campaign|graduation|creatorEconomics/i);
  assert.match(detailsSource, /ImportedTokenDetails/);
});
