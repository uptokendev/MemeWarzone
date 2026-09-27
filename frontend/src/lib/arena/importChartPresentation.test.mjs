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

test("import candles (USD) become native rows the chart multiplies back to exactly the same USD", async () => {
  const { importUsdCandlesToChart, clampImportResolution } = await import("./importChartPresentation.mjs");
  const usd = [
    { bucket_start: "2026-09-27T00:00:00.000Z", o: "0.00006", h: "0.00007", l: "0.00005", c: "0.000064", mcap_o: "57600", mcap_h: "67200", mcap_l: "48000", mcap_c: "61440", volume_usd: "24" },
    { bucket_start: "2026-09-28T00:00:00.000Z", o: "0", h: "1", l: "1", c: "1", mcap_o: null, mcap_h: null, mcap_l: null, mcap_c: null, volume_usd: "1" },
  ];
  const rows = importUsdCandlesToChart(usd, 200);
  assert.equal(rows.length, 1, "a bar with a zero price is dropped, never drawn");
  assert.ok(Math.abs(Number(rows[0].c) * 200 - 0.000064) < 1e-15);
  assert.ok(Math.abs(Number(rows[0].mcap_c) * 200 - 61440) < 1e-9);
  assert.equal(rows[0].trades_count, 1);
  assert.equal(rows[0].price_c, rows[0].c);
  assert.deepEqual(importUsdCandlesToChart(usd, 0), [], "no native/USD rate: nothing to draw");
  assert.equal(clampImportResolution("1s"), "1m");
  assert.equal(clampImportResolution("4h"), "4h");
  assert.equal(clampImportResolution("bogus"), "1h");
});

test("empty chart note distinguishes loading, no pool and not yet indexed", () => {
  assert.equal(presentImportChart({}, [], 101, "M", { loading: true }).emptyNote, null);
  assert.equal(presentImportChart({}, [], 101, "M", { reason: "NO_POOL" }).emptyNote, "No DEX pool found for this token yet");
});
