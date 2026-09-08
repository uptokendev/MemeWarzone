import test from "node:test";
import assert from "node:assert/strict";

import { getArenaMarketSnapshot } from "./arenaMarketSnapshot.js";

const chainId = 46630;
const campaignAddress = "0x0000000000000000000000000000000000004630";
const tokenAddress = "0x0000000000000000000000000000000000004631";
const stockToken = "0x0000000000000000000000000000000000004638";

function normalizedStockQuery(sql) {
  if (sql.includes("from public.campaigns c")) {
    return {
      rows: [{
        chain_id: chainId,
        campaign_address: campaignAddress,
        token_address: tokenAddress,
        creator_address: "0x0000000000000000000000000000000000004636",
        fee_recipient_address: "0x0000000000000000000000000000000000004637",
        name: "RH Stock Proof",
        symbol: "RHSP",
      }],
    };
  }
  if (sql.includes("from public.market_stats")) {
    return {
      rows: [{
        market_cap_usd: "24100000",
        liquidity_usd: "30125",
        volume_24h_usd: "87234.56",
        market_cap_bnb: null,
        liquidity_bnb: null,
        holders: 420,
        volume_24h_bnb: null,
        quote_asset_type: "STOCK_TOKEN",
        quote_token_address: stockToken,
        updated_at: "2026-09-03T10:00:00.000Z",
        data_lag_seconds: 5,
      }],
    };
  }
  throw new Error(`Unexpected Arena market query in Robinhood compatibility proof: ${sql}`);
}

test("Battle V2 consumes normalized Robinhood Stock USD fields without native-price fallback", async () => {
  let nativePriceCalls = 0;
  const snapshot = await getArenaMarketSnapshot(chainId, tokenAddress, {
    query: async (sql) => normalizedStockQuery(sql),
    nowMs: Date.parse("2026-09-03T10:00:05.000Z"),
    staleSeconds: 60,
    resolveNativeUsd: async () => {
      nativePriceCalls += 1;
      throw new Error("Stock market snapshot must not request native ETH/USD valuation");
    },
  });

  assert.equal(nativePriceCalls, 0);
  assert.equal(snapshot.marketCapUsd, 24100000);
  assert.equal(snapshot.liquidityUsd, 30125);
  assert.equal(snapshot.volume24hUsd, 87234.56);
  assert.equal(snapshot.holders, 420);
  assert.equal(snapshot.quoteAssetType, "STOCK_TOKEN");
  assert.equal(snapshot.quoteTokenAddress, stockToken.toLowerCase());
  assert.equal(snapshot.nativeUsdPrice, null);
  assert.equal(snapshot.fxSource, "not_applicable_stock_quote");
  assert.equal(snapshot.dataSource, "normalized_stock_market_stats");
  assert.equal(snapshot.healthy, true);
  assert.deepEqual(snapshot.reasons, []);
});
