import assert from "node:assert/strict";
import test from "node:test";
import { robinhoodV3TradeInternals } from "./robinhoodV3Trade.ts";
import type { MarketRoute } from "./marketContinuityApi.ts";

function baseRoute(overrides: Partial<MarketRoute> = {}): MarketRoute {
  return {
    chainId: 46630,
    marketStage: "DEX_ACTIVE",
    campaignAddress: "0x0000000000000000000000000000000000000001",
    token: "0x0000000000000000000000000000000000000002",
    pair: "0x0000000000000000000000000000000000000003",
    router: "0x0000000000000000000000000000000000000004",
    factory: "0x0000000000000000000000000000000000000005",
    wrappedNative: "0x0000000000000000000000000000000000000006",
    stable: false,
    feeBps: 30,
    verified: true,
    tradingEnabled: true,
    verifiedAt: null,
    lastError: null,
    ...overrides,
  };
}

test("legacy Robinhood routes default to direct wrapped-native metadata", () => {
  const descriptor = robinhoodV3TradeInternals.describeRobinhoodV3Route(
    baseRoute({ quoteToken: null, quoteAssetType: undefined, routeKind: undefined, referenceOracle: null }),
  );
  assert.equal(descriptor.quoteTokenAddress, "0x0000000000000000000000000000000000000006");
  assert.equal(descriptor.quoteAssetType, "WRAPPED_NATIVE");
  assert.equal(descriptor.routeKind, "DIRECT_NATIVE");
  assert.equal(descriptor.referenceOracleAddress, null);
});

test("stock Robinhood routes preserve quote token and oracle metadata", () => {
  const descriptor = robinhoodV3TradeInternals.describeRobinhoodV3Route(
    baseRoute({
      quoteToken: "0x0000000000000000000000000000000000000007",
      quoteAssetType: "STOCK_TOKEN",
      routeKind: "STOCK_TWO_HOP",
      referenceOracle: "0x0000000000000000000000000000000000000008",
    }),
  );
  assert.equal(descriptor.quoteTokenAddress, "0x0000000000000000000000000000000000000007");
  assert.equal(descriptor.quoteAssetType, "STOCK_TOKEN");
  assert.equal(descriptor.routeKind, "STOCK_TWO_HOP");
  assert.equal(descriptor.referenceOracleAddress, "0x0000000000000000000000000000000000000008");
});
