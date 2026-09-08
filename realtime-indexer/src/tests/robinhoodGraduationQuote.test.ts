import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateRobinhoodGraduationQuote,
  type RobinhoodGraduationQuoteInput,
  type RobinhoodGraduationQuotePolicy,
} from "../robinhoodGraduationQuote.js";

const policy: RobinhoodGraduationQuotePolicy = {
  version: "robinhood_stock_graduation_v1",
  maxOracleAgeSeconds: 900,
  maxSwapSlippageBps: 300,
  maxOracleDeviationBps: 300,
  maxPriceImpactBps: 500,
  minimumRouteLiquidityUsd: 25000,
  quoteDeadlineSeconds: 60,
};

const nowMs = 1_800_000_000_000;

function valid(overrides: Partial<RobinhoodGraduationQuoteInput> = {}): RobinhoodGraduationQuoteInput {
  return {
    nowMs,
    quoteTimestampMs: nowMs,
    deadlineMs: nowMs + 30_000,
    nativeLiquidityUsd: 30_000,
    expectedQuoteOutRaw: 100_000_000n,
    minimumQuoteOutRaw: 98_000_000n,
    routeLiquidityUsd: 250_000,
    priceImpactBps: 120,
    oracleDeviationBps: 80,
    oracleHealthy: true,
    oracleUpdatedAtMs: nowMs - 60_000,
    canonicalToken: true,
    graduationEnabled: true,
    routeVerified: true,
    campaignEligible: true,
    ...overrides,
  };
}

test("accepts a healthy canonical Stock Token graduation quote", () => {
  const decision = evaluateRobinhoodGraduationQuote(valid(), policy);
  assert.equal(decision.accepted, true);
  assert.deepEqual(decision.failures, []);
  assert.equal(decision.slippageBps, 200);
  assert.equal(decision.oracleAgeSeconds, 60);
});

test("fails closed when Stock Token or route is not approved", () => {
  const decision = evaluateRobinhoodGraduationQuote(valid({ canonicalToken: false, graduationEnabled: false, routeVerified: false }), policy);
  assert.equal(decision.accepted, false);
  assert.deepEqual(decision.failures, [
    "STOCK_TOKEN_NOT_CANONICAL",
    "STOCK_TOKEN_GRADUATION_DISABLED",
    "ROUTE_UNVERIFIED",
  ]);
});

test("rejects stale oracle, high impact, low liquidity and oracle deviation", () => {
  const decision = evaluateRobinhoodGraduationQuote(valid({
    oracleUpdatedAtMs: nowMs - 901_000,
    routeLiquidityUsd: 10_000,
    priceImpactBps: 501,
    oracleDeviationBps: 301,
  }), policy);
  assert.equal(decision.accepted, false);
  assert.ok(decision.failures.includes("ORACLE_STALE"));
  assert.ok(decision.failures.includes("ROUTE_LIQUIDITY_TOO_LOW"));
  assert.ok(decision.failures.includes("PRICE_IMPACT_TOO_HIGH"));
  assert.ok(decision.failures.includes("ORACLE_DEVIATION_TOO_HIGH"));
});

test("rejects slippage above configured limit and expired deadlines", () => {
  const decision = evaluateRobinhoodGraduationQuote(valid({
    minimumQuoteOutRaw: 95_000_000n,
    deadlineMs: nowMs - 1,
  }), policy);
  assert.equal(decision.accepted, false);
  assert.equal(decision.slippageBps, 500);
  assert.ok(decision.failures.includes("SLIPPAGE_TOO_HIGH"));
  assert.ok(decision.failures.includes("QUOTE_DEADLINE_EXPIRED"));
});

test("never accepts zero output or ineligible campaign", () => {
  const decision = evaluateRobinhoodGraduationQuote(valid({ expectedQuoteOutRaw: 0n, minimumQuoteOutRaw: 0n, campaignEligible: false }), policy);
  assert.equal(decision.accepted, false);
  assert.ok(decision.failures.includes("ZERO_QUOTED_OUTPUT"));
  assert.ok(decision.failures.includes("SLIPPAGE_TOO_HIGH"));
  assert.ok(decision.failures.includes("CAMPAIGN_NOT_ELIGIBLE"));
});
