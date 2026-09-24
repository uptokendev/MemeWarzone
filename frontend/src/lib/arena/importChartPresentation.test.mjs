import assert from "node:assert/strict";
import test from "node:test";

import {
  admissionPill,
  importTradingBlocked,
  presentImportChart,
} from "./importChartPresentation.mjs";

test("trading is blocked only for honeypot or non-transferable security, not for admission review", () => {
  assert.equal(importTradingBlocked({ hardFindings: [] }, { status: "pass" }), false);
  assert.equal(importTradingBlocked({ hardFindings: [{ code: "honeypot_sell_failed" }] }, null), true);
  assert.equal(importTradingBlocked({}, { status: "blocked", criticalRisks: [{ code: "is_honeypot" }] }), true);
  assert.equal(importTradingBlocked({ hardFindings: [{ code: "owner_not_renounced" }] }, { status: "review" }), false);
});

test("import chart uses indexer candles when present and never invents buckets", () => {
  const empty = presentImportChart({ marketCapUsd: 12, liquidityUsd: 4 }, [], 101, "Mint111");
  assert.deepEqual(empty.candles, []);
  assert.equal(empty.emptyNote, "Chart appears once trades are indexed");
  assert.equal(empty.marketState.marketCapUsd, 12);
  const filled = presentImportChart({ liquidityUsd: 9 }, [{ time: 1, open: 1, high: 1, low: 1, close: 1 }], 56, "0xabc");
  assert.equal(filled.candles.length, 1);
  assert.equal(filled.emptyNote, null);
});

test("admission pill maps scan status for the token header", () => {
  assert.equal(admissionPill("passed").label, "Arena: eligible");
  assert.equal(admissionPill("needs_review").label, "Arena: needs review");
  assert.equal(admissionPill("declined").label, "Arena: declined");
  assert.equal(admissionPill("scanning").label, "Arena: scanning");
});
