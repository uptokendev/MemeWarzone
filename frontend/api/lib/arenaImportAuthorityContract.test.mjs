import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  IMPORT_AUTHORITY_OUTCOME,
  effectiveImportedAuthorityOutcome,
  evaluateImportedCompetitionEligibility,
} from "./arenaImportEligibility.js";
import { ARENA_IMPORT_SCAN_VERSION, FINDING_AUTHORITY } from "./arenaImportScan.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const contract = fs.readFileSync(path.resolve(here, "../../../docs/arena/imported-token-authority-api.md"), "utf8");
const battleSource = fs.readFileSync(path.resolve(here, "../arenaBattles.js"), "utf8");
const tournamentSource = fs.readFileSync(path.resolve(here, "../arenaTournaments.js"), "utf8");
const leagueSource = fs.readFileSync(path.resolve(here, "../arenaLeague.js"), "utf8");
const eligibilitySource = fs.readFileSync(path.resolve(here, "./arenaEligibility.js"), "utf8");

const now = new Date("2026-09-05T12:00:00.000Z");
function approvedRow(overrides = {}) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    status: "passed",
    state_version: 7,
    scan_version: ARENA_IMPORT_SCAN_VERSION,
    scanned_at: "2026-09-05T11:00:00.000Z",
    scan_json: {
      scanVersion: ARENA_IMPORT_SCAN_VERSION,
      scannedAt: "2026-09-05T11:00:00.000Z",
      findings: [],
    },
    ...overrides,
  };
}

test("effective authority exposes passed, review, hard failure, stale and rejected distinctly", () => {
  assert.equal(effectiveImportedAuthorityOutcome(approvedRow(), now), IMPORT_AUTHORITY_OUTCOME.PASSED);
  assert.equal(effectiveImportedAuthorityOutcome(approvedRow({ status: "needs_review" }), now), IMPORT_AUTHORITY_OUTCOME.NEEDS_REVIEW);
  assert.equal(
    effectiveImportedAuthorityOutcome(approvedRow({
      scan_json: {
        scanVersion: ARENA_IMPORT_SCAN_VERSION,
        scannedAt: "2026-09-05T11:00:00.000Z",
        findings: [{ code: "not_a_mint", authority: FINDING_AUTHORITY.NON_OVERRIDABLE }],
      },
    }), now),
    IMPORT_AUTHORITY_OUTCOME.HARD_FAILURE,
  );
  assert.equal(
    effectiveImportedAuthorityOutcome(approvedRow({
      scanned_at: "2026-08-01T00:00:00.000Z",
      scan_json: { scanVersion: ARENA_IMPORT_SCAN_VERSION, scannedAt: "2026-08-01T00:00:00.000Z", findings: [] },
    }), now),
    IMPORT_AUTHORITY_OUTCOME.STALE,
  );
  assert.equal(effectiveImportedAuthorityOutcome(approvedRow({ status: "declined" }), now), IMPORT_AUTHORITY_OUTCOME.REJECTED);
});

test("canonical eligibility includes the frozen authority outcome", () => {
  const result = evaluateImportedCompetitionEligibility(approvedRow(), now);
  assert.equal(result.eligible, true);
  assert.equal(result.authorityOutcome, "passed");
  assert.equal(result.stateVersion, 7);
});

test("frozen Agent 4 contract names every required surface and field", () => {
  for (const required of [
    "GET /api/admin/arena/imports",
    "GET /api/admin/arena/imports?id=<uuid>",
    "POST /api/admin/arena/imports/:id/rescan",
    "POST /api/admin/arena/imports/:id/approve",
    "POST /api/admin/arena/imports/:id/reject",
    "GET /api/arena/imports/eligibility?chainId=<chainId>&token=<tokenAddress>",
    "authorityOutcome",
    "actionPolicy",
    "evidenceVersion",
    "stateVersion",
    "IMPORT_STATE_CONFLICT",
    "NON_OVERRIDABLE",
    "future admission",
  ]) {
    assert.match(contract, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("battle discovery, find-match, open/challenge and auto-match use imported eligibility", () => {
  assert.match(battleSource, /evaluateImportedCompetitionEligibility/);
  assert.match(battleSource, /if \(!creatorStatus\.eligibility\)/);
  assert.match(battleSource, /if \(!challengerStatus\.eligibility\)/);
  assert.match(battleSource, /if \(!defenderStatus\.eligibility\)/);
  assert.match(battleSource, /if \(!evaluateImportedCompetitionEligibility\(row\)\.eligible\) continue/);
  assert.match(battleSource, /rivalCoin\?\.origin === "import" && !evaluateImportedCompetitionEligibility\(rivalCoin\)\.eligible/);
});

test("tournament and MWL new admission consume the canonical resolver", () => {
  assert.match(tournamentSource, /tokenEligible as tokenIsEligible/);
  assert.match(tournamentSource, /if \(!\(await tokenEligible\(row\.chain_id, token\)\)\)/);
  assert.match(leagueSource, /import \{ tokenEligible \} from "\.\/lib\/arenaEligibility\.js"/);
  assert.match(leagueSource, /if \(!\(await tokenEligible\(pool, chainId, coin\.tokenAddress\)\)\)/);
  assert.match(eligibilitySource, /evaluateImportedCompetitionEligibility/);
});

test("eligibility helper is admission-only and cannot rewrite running competitions", () => {
  const source = fs.readFileSync(path.resolve(here, "./arenaImportEligibility.js"), "utf8");
  assert.equal(/update\s+public\.arena_(battles|tournaments|league)/i.test(source), false);
  assert.match(source, /never mutates existing battle\/tournament\/league rows/);
});
