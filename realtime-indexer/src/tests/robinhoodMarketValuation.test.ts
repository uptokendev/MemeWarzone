import test from "node:test";
import assert from "node:assert/strict";

const {
  deriveRobinhoodUsdValuation,
  multiplyDecimalStrings,
  rawAmountToDecimal,
} = await import("../robinhoodMarketValuation.js");

test("derives Stock-quoted MEME USD price, volume, market cap and liquidity without treating Stock as native", () => {
  const valuation = deriveRobinhoodUsdValuation({
    priceQuote: "0.00025",
    quotePriceUsd: "120.50",
    quoteTradeAmount: "2.5",
    postBurnTotalSupplyRaw: "800000000000000000000000000",
    baseDecimals: 18,
    reserveQuoteRaw: "12500000000",
    quoteDecimals: 8,
  });

  assert.equal(valuation.priceUsd, "0.030125");
  assert.equal(valuation.volumeUsd, "301.25");
  assert.equal(valuation.marketCapUsd, "24100000");
  assert.equal(valuation.liquidityUsd, "30125");
});

test("uses the same normalized formula for wrapped-native quote assets", () => {
  const valuation = deriveRobinhoodUsdValuation({
    priceQuote: "0.0000005",
    quotePriceUsd: "4000",
    quoteTradeAmount: "1.25",
    postBurnTotalSupplyRaw: "1000000000000000000000000000",
    baseDecimals: 18,
    reserveQuoteRaw: "5000000000000000000",
    quoteDecimals: 18,
  });

  assert.equal(valuation.priceUsd, "0.002");
  assert.equal(valuation.volumeUsd, "5000");
  assert.equal(valuation.marketCapUsd, "2000000");
  assert.equal(valuation.liquidityUsd, "40000");
});

test("handles quote tokens with non-18 decimals exactly", () => {
  assert.equal(rawAmountToDecimal("123456789", 8), "1.23456789");
  assert.equal(rawAmountToDecimal("1234567890123456789", 18), "1.234567890123456789");
  assert.equal(rawAmountToDecimal("1000000", 6), "1");
});

test("decimal multiplication remains bigint-based for values above JS safe integer range", () => {
  assert.equal(
    multiplyDecimalStrings("12345678901234567890.123456789012345678", "98765.43210987654321"),
    "1219326311370217952249657.064224965706333485",
  );
});

test("missing or invalid reference price never fabricates normalized USD", () => {
  const missing = deriveRobinhoodUsdValuation({
    priceQuote: "0.5",
    quotePriceUsd: null,
    quoteTradeAmount: "10",
    postBurnTotalSupplyRaw: "1000000000000000000",
    reserveQuoteRaw: "1000000000000000000",
  });
  assert.deepEqual(missing, {
    priceUsd: null,
    volumeUsd: null,
    marketCapUsd: null,
    liquidityUsd: null,
  });

  const invalid = deriveRobinhoodUsdValuation({
    priceQuote: "0.5",
    quotePriceUsd: "not-a-price",
    quoteTradeAmount: "10",
  });
  assert.equal(invalid.priceUsd, null);
  assert.equal(invalid.volumeUsd, null);
});
