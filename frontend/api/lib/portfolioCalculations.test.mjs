import assert from "node:assert/strict";
import test from "node:test";

import { derivePortfolioMetrics } from "./portfolioCalculations.js";

test("coinsCount uses holdingsCount even when holdings are unpriced", () => {
  const metrics = derivePortfolioMetrics({
    nativeBnb: 0,
    tokenHoldingsWithValues: [{ ticker: "K88", valueUsd: 0 }],
    bnbUsd: 150,
    createdAt: "2026-09-25T00:00:00.000Z",
    holdingsCount: 3,
  });
  assert.equal(metrics.coinsCount, 3);
  assert.equal(metrics.totalValueUsd, null);
  assert.equal(metrics.topHolding, null);
});

test("Solana-shaped input is accepted and unpriced totals stay null", () => {
  const metrics = derivePortfolioMetrics({
    nativeBnb: 1.5,
    tokenHoldingsWithValues: [{ ticker: "K88", valueUsd: 12.5 }],
    bnbUsd: 200,
    createdAt: "2026-01-01T00:00:00.000Z",
    holdingsCount: 1,
  });
  assert.equal(metrics.coinsCount, 1);
  assert.equal(metrics.topHolding?.ticker, "K88");
  assert.ok(metrics.totalValueUsd > 0);
  assert.notEqual(metrics.walletAge, "on-chain");
});
