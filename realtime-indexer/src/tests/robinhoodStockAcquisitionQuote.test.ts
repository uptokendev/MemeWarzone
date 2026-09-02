import test from "node:test";
import assert from "node:assert/strict";

process.env.RUNTIME_ENVIRONMENT = "local";
process.env.LOCAL_DISABLE_ABLY = "1";
process.env.DATABASE_URL ||= "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
process.env.ABLY_API_KEY ||= "test.test";
process.env.VITE_WRAPPED_NATIVE_ADDRESS_46630 = "0x00000000000000000000000000000000000000AA";
process.env.ROBINHOOD_STOCK_TOKEN_REGISTRY_46630 = JSON.stringify([
  {
    contractAddress: "0x0000000000000000000000000000000000000011",
    symbol: "NVDA",
    displayName: "NVIDIA Stock Token",
    underlyingSymbol: "NVDA",
    decimals: 8,
    oracleFeedAddress: "0x0000000000000000000000000000000000000022",
    canonical: true,
    enabledForDiscovery: true,
    enabledForGraduation: true,
    enabledForTrading: false,
    acquisitionPoolAddress: "0x0000000000000000000000000000000000000033",
    acquisitionQuoterAddress: "0x0000000000000000000000000000000000000044",
    acquisitionRouterAddress: "0x0000000000000000000000000000000000000055",
    acquisitionFeeTier: 3000,
    acquisitionQuoteKind: "SIMPLE_EXACT_INPUT_SINGLE",
  },
  {
    contractAddress: "0x0000000000000000000000000000000000000066",
    symbol: "TSLA",
    oracleFeedAddress: "0x0000000000000000000000000000000000000077",
    canonical: true,
    enabledForDiscovery: true,
    enabledForGraduation: false,
  },
]);

const {
  buildRobinhoodStockAcquisitionPlan,
  calculateAcquisitionPriceImpactBps,
  minimumOutForSlippage,
} = await import("../robinhoodStockAcquisitionQuote.js");

test("builds a fail-closed WETH to Stock acquisition plan from canonical registry metadata", () => {
  const result = buildRobinhoodStockAcquisitionPlan(46630, "0x0000000000000000000000000000000000000011");
  assert.deepEqual(result.failures, []);
  assert.ok(result.plan);
  assert.equal(result.plan.wrappedNativeAddress, "0x00000000000000000000000000000000000000AA");
  assert.equal(result.plan.stockTokenAddress, "0x0000000000000000000000000000000000000011");
  assert.equal(result.plan.poolAddress, "0x0000000000000000000000000000000000000033");
  assert.equal(result.plan.quoterAddress, "0x0000000000000000000000000000000000000044");
  assert.equal(result.plan.feeTier, 3000);
  assert.equal(result.plan.quoteKind, "SIMPLE_EXACT_INPUT_SINGLE");
});

test("refuses graduation-disabled Stock Tokens before any RPC call", () => {
  const result = buildRobinhoodStockAcquisitionPlan(46630, "0x0000000000000000000000000000000000000066");
  assert.equal(result.plan, null);
  assert.ok(result.failures.includes("STOCK_TOKEN_GRADUATION_DISABLED"));
  assert.ok(result.failures.includes("ACQUISITION_VENUE_INCOMPLETE"));
});

test("refuses unregistered Stock Tokens before any RPC call", () => {
  const result = buildRobinhoodStockAcquisitionPlan(46630, "0x0000000000000000000000000000000000000099");
  assert.equal(result.plan, null);
  assert.deepEqual(result.failures, ["STOCK_TOKEN_NOT_REGISTERED"]);
});

test("calculates price impact against a small probe quote", () => {
  const impact = calculateAcquisitionPriceImpactBps({
    amountInRaw: 1000n,
    amountOutRaw: 9500n,
    probeAmountInRaw: 100n,
    probeAmountOutRaw: 1000n,
  });
  assert.equal(impact, 500);
});

test("does not report negative price impact when the full quote improves", () => {
  const impact = calculateAcquisitionPriceImpactBps({
    amountInRaw: 1000n,
    amountOutRaw: 10100n,
    probeAmountInRaw: 100n,
    probeAmountOutRaw: 1000n,
  });
  assert.equal(impact, 0);
});

test("derives an exact minimum quote output from slippage policy", () => {
  assert.equal(minimumOutForSlippage(10_000n, 300), 9700n);
  assert.equal(minimumOutForSlippage(10_000n, 10_001), null);
});
