import test from "node:test";
import assert from "node:assert/strict";

process.env.ROBINHOOD_STOCK_TOKEN_REGISTRY_46630 = JSON.stringify([
  {
    chainId: 46630,
    contractAddress: "0x0000000000000000000000000000000000000033",
    symbol: "NVDA",
    displayName: "NVIDIA Stock Token",
    underlyingSymbol: "NVDA",
    decimals: 8,
    oracleFeedAddress: "0x0000000000000000000000000000000000000099",
    canonical: true,
    enabledForDiscovery: true,
    enabledForGraduation: true,
    enabledForTrading: true,
  },
]);

const { buildRobinhoodMarketRoute } = await import("../robinhoodMarketRoutes.js");

const campaign = "0x0000000000000000000000000000000000000010";
const meme = "0x0000000000000000000000000000000000000011";
const weth = "0x0000000000000000000000000000000000000022";
const nvda = "0x0000000000000000000000000000000000000033";
const pool = "0x0000000000000000000000000000000000000044";
const router = "0x0000000000000000000000000000000000000055";
const factory = "0x0000000000000000000000000000000000000066";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    chain_id: 46630,
    campaign_address: campaign,
    pool_address: pool,
    base_token_address: meme,
    quote_token_address: weth,
    base_decimals: 18,
    quote_decimals: 18,
    quote_asset_type: "WRAPPED_NATIVE",
    market_role: "CANONICAL_NATIVE",
    fee_tier: 3000,
    router_address: router,
    factory_address: factory,
    verified: true,
    trading_enabled: true,
    indexing_enabled: true,
    oracle_feed_address: null,
    market_policy_version: "robinhood_market_v1",
    ...overrides,
  };
}

test("native market route remains DIRECT_NATIVE and ETH-centric", () => {
  const route = buildRobinhoodMarketRoute({ row: row(), wrappedNativeAddress: weth, side: "buy" });
  assert.equal(route.routeKind, "DIRECT_NATIVE");
  assert.equal(route.quoteAssetType, "WRAPPED_NATIVE");
  assert.equal(route.canonical, true);
  assert.equal(route.inputAsset, "native:eth");
  assert.equal(route.outputAsset, meme.toLowerCase());
  assert.deepEqual(route.legs, [{ from: "native:eth", to: meme.toLowerCase() }]);
});

test("stock market route is STOCK_TWO_HOP while user still trades ETH in/out", () => {
  const route = buildRobinhoodMarketRoute({
    row: row({
      quote_token_address: nvda,
      quote_decimals: 8,
      quote_asset_type: "STOCK_TOKEN",
      market_role: "CANONICAL_STOCK",
      oracle_feed_address: "0x0000000000000000000000000000000000000099",
    }),
    wrappedNativeAddress: weth,
    side: "buy",
  });
  assert.equal(route.routeKind, "STOCK_TWO_HOP");
  assert.equal(route.quoteAssetType, "STOCK_TOKEN");
  assert.equal(route.quoteDecimals, 8);
  assert.equal(route.referenceOracle?.toLowerCase(), "0x0000000000000000000000000000000000000099");
  assert.equal(route.inputAsset, "native:eth");
  assert.equal(route.outputAsset, meme.toLowerCase());
  assert.deepEqual(route.legs, [
    { from: "native:eth", to: nvda.toLowerCase() },
    { from: nvda.toLowerCase(), to: meme.toLowerCase() },
  ]);
});

test("stock sell route returns ETH without exposing intermediate Stock Token to user", () => {
  const route = buildRobinhoodMarketRoute({
    row: row({ quote_token_address: nvda, quote_asset_type: "STOCK_TOKEN", market_role: "CANONICAL_STOCK" }),
    wrappedNativeAddress: weth,
    side: "sell",
  });
  assert.equal(route.inputAsset, meme.toLowerCase());
  assert.equal(route.outputAsset, "native:eth");
  assert.deepEqual(route.legs, [
    { from: meme.toLowerCase(), to: nvda.toLowerCase() },
    { from: nvda.toLowerCase(), to: "native:eth" },
  ]);
});
