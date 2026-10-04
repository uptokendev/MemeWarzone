import test from "node:test";
import assert from "node:assert/strict";
import { DBC_LEAGUE_CREDIT_FROM_MS, sumCollectorDeposits, type CollectorTx } from "../rewards/dbcLeagueCredit.js";

const COLLECTOR = "3NWtsXixUR3eJjPSNTSVJ62eVxTD4ExHyvdop6TURorY";
const WEEKLY = "FAKPndjQa3XppkNdk8SDGGWbZG2cPWJWhsDR2EWE9yWK";
const MONTHLY = "68FNNeXDMAU8XaJsNYL4VFY2YnprnE36LCncCm8uRyJg";
const FROM = Date.parse("2026-10-05T00:00:00Z");
const TO = Date.parse("2026-10-12T00:00:00Z");

function route(ms: number, weekly: number, monthly: number, extra: Partial<CollectorTx> = {}): CollectorTx {
  return {
    blockTimeMs: ms,
    failed: false,
    feePayer: COLLECTOR,
    accountKeys: [COLLECTOR, MONTHLY, WEEKLY],
    preBalances: [1_000_000_000, 500, 700],
    postBalances: [1_000_000_000 - weekly - monthly, 500 + monthly, 700 + weekly],
    ...extra,
  };
}

// The real 2026-10-01 route: one transfer per vault, 30/70.
test("credits the collector's deposit into the vault of the period", () => {
  const txs = [route(FROM + 1000, 101_542_219, 236_931_846)];
  assert.equal(sumCollectorDeposits(txs, WEEKLY, COLLECTOR, FROM, TO), 101_542_219n);
  assert.equal(sumCollectorDeposits(txs, MONTHLY, COLLECTOR, FROM, TO), 236_931_846n);
});

test("a deposit belongs to exactly one epoch: start inclusive, end exclusive", () => {
  const txs = [route(FROM, 10, 0), route(TO, 20, 0), route(TO - 1, 30, 0)];
  assert.equal(sumCollectorDeposits(txs, WEEKLY, COLLECTOR, FROM, TO), 40n);
  assert.equal(sumCollectorDeposits(txs, WEEKLY, COLLECTOR, TO, TO + 7 * 86400_000), 20n);
});

test("ignores failed transactions, other fee payers and outflows", () => {
  const txs = [
    route(FROM + 1, 10, 0, { failed: true }),
    route(FROM + 2, 20, 0, { feePayer: "9YN7WY8svWoeNgegS2oq7uNDyrdcfg9UDUQR7tWpeF8H" }),
    route(FROM + 3, -50, 0),
    route(FROM + 4, 5, 0),
  ];
  assert.equal(sumCollectorDeposits(txs, WEEKLY, COLLECTOR, FROM, TO), 5n);
});

test("deposits before the 2026-10-04 top-up are never credited again", () => {
  assert.equal(DBC_LEAGUE_CREDIT_FROM_MS, Date.parse("2026-10-04T15:28:33Z"));
  assert.ok(Date.parse("2026-10-01T19:07:19Z") < DBC_LEAGUE_CREDIT_FROM_MS, "the Oct 1 route was paid by the top-up");
});
