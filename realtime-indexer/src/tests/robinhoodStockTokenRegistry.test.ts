import test from "node:test";
import assert from "node:assert/strict";

process.env.RUNTIME_ENVIRONMENT = "local";
process.env.LOCAL_DISABLE_ABLY = "1";
process.env.DATABASE_URL ||= "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
process.env.ABLY_API_KEY ||= "test.test";
process.env.ROBINHOOD_STOCK_TOKEN_REGISTRY_46630 = JSON.stringify([
  {
    contractAddress: "0x0000000000000000000000000000000000000011",
    symbol: "NVDA",
    displayName: "NVIDIA Stock Token",
    underlyingSymbol: "NVDA",
    oracleFeedAddress: "0x0000000000000000000000000000000000000022",
    enabledForDiscovery: true,
    enabledForGraduation: true,
    enabledForTrading: false,
  },
  {
    chainId: 4663,
    contractAddress: "0x0000000000000000000000000000000000000033",
    symbol: "TSLA",
    oracleFeedAddress: "0x0000000000000000000000000000000000000044",
  },
]);

const {
  describeRobinhoodQuoteAsset,
  listRobinhoodStockTokens,
  robinhoodStockRegistryInternals,
} = await import("../robinhoodStockTokenRegistry.js");
const { robinhoodMarketApiInternals } = await import("../robinhoodMarketApi.js");

test("parses the Robinhood stock token registry and filters cross-chain entries", () => {
  const items = listRobinhoodStockTokens(46630);
  assert.equal(items.length, 1);
  assert.equal(items[0].symbol, "NVDA");
  assert.equal(items[0].enabledForGraduation, true);
  assert.equal(items[0].contractAddress, "0x0000000000000000000000000000000000000011");
});

test("classifies wrapped-native Robinhood routes without a stock token", () => {
  const descriptor = describeRobinhoodQuoteAsset({
    chainId: 46630,
    quoteToken: "0x00000000000000000000000000000000000000AA",
    wrappedNativeAddress: "0x00000000000000000000000000000000000000AA",
  });
  assert.equal(descriptor.quoteAssetType, "WRAPPED_NATIVE");
  assert.equal(descriptor.routeKind, "DIRECT_NATIVE");
  assert.equal(descriptor.referenceOracle, null);
});

test("classifies registered stock quote assets as Stock Battlefield routes", () => {
  const descriptor = describeRobinhoodQuoteAsset({
    chainId: 46630,
    quoteToken: "0x0000000000000000000000000000000000000011",
    wrappedNativeAddress: "0x00000000000000000000000000000000000000AA",
  });
  assert.equal(descriptor.quoteAssetType, "STOCK_TOKEN");
  assert.equal(descriptor.routeKind, "STOCK_TWO_HOP");
  assert.equal(descriptor.referenceOracle, "0x0000000000000000000000000000000000000022");
  assert.equal(descriptor.stockToken?.symbol, "NVDA");
});

test("derives the Robinhood quote token from pool token sides", () => {
  const quoteToken = robinhoodMarketApiInternals.deriveQuoteTokenAddress({
    tokenAddress: "0x00000000000000000000000000000000000000BB",
    token0Address: "0x00000000000000000000000000000000000000BB",
    token1Address: "0x0000000000000000000000000000000000000011",
    wrappedNativeAddress: "0x00000000000000000000000000000000000000AA",
  });
  assert.equal(quoteToken, "0x0000000000000000000000000000000000000011");
});

test("builds stock-token route metadata from the derived quote asset", async () => {
  const metadata = await robinhoodMarketApiInternals.buildRobinhoodMarketMetadata(
    {
      chainId: 46630,
      campaignAddress: "0x0000000000000000000000000000000000000044",
      tokenAddress: "0x00000000000000000000000000000000000000BB",
      quoteTokenAddress: robinhoodMarketApiInternals.deriveQuoteTokenAddress({
        tokenAddress: "0x00000000000000000000000000000000000000BB",
        token0Address: "0x00000000000000000000000000000000000000BB",
        token1Address: "0x0000000000000000000000000000000000000011",
        wrappedNativeAddress: "0x00000000000000000000000000000000000000AA",
      }),
      wrappedNativeAddress: "0x00000000000000000000000000000000000000AA",
    },
    false,
  );

  assert.equal(metadata.quoteToken, "0x0000000000000000000000000000000000000011");
  assert.equal(metadata.quoteAssetType, "STOCK_TOKEN");
  assert.equal(metadata.routeKind, "STOCK_TWO_HOP");
  assert.equal(metadata.referenceOracle, "0x0000000000000000000000000000000000000022");
  assert.equal(metadata.stockToken?.symbol, "NVDA");
});

test("normalizes checksummed Robinhood stock token addresses", () => {
  const normalized = robinhoodStockRegistryInternals.normalizeAddress("0x0000000000000000000000000000000000000011");
  assert.equal(normalized, "0x0000000000000000000000000000000000000011");
});
