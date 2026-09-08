import test from "node:test";
import assert from "node:assert/strict";

const { computeRobinhoodBeatTheMarket } = await import("../robinhoodBeatTheMarketService.js");

const NOW = Date.parse("2026-09-03T10:00:00.000Z");
const CAMPAIGN = "0x0000000000000000000000000000000000000044";
const STOCK = "0x0000000000000000000000000000000000000099";

function currentRow(overrides: Record<string, unknown> = {}) {
  return {
    last_price_usd: "1.2",
    reference_price_usd: "110",
    reference_price_updated_at: "2026-09-03T09:59:00.000Z",
    valuation_source: "stock_oracle:chainlink",
    valuation_healthy: true,
    updated_at: "2026-09-03T10:00:00.000Z",
    quote_asset_type: "STOCK_TOKEN",
    quote_token_address: STOCK,
    ...overrides,
  };
}

function startRow(overrides: Record<string, unknown> = {}) {
  return {
    bucket_start: "2026-09-02T10:00:00.000Z",
    c_usd: "1",
    reference_price_usd: "100",
    reference_price_updated_at: "2026-09-02T10:00:00.000Z",
    valuation_source: "stock_oracle:chainlink",
    valuation_healthy: true,
    ...overrides,
  };
}

function queryFixture(input: { current?: any; start?: any; capture?: unknown[][] } = {}) {
  return async (text: string, params: unknown[] = []) => {
    if (text.includes("from public.market_stats")) return { rows: input.current === null ? [] : [input.current || currentRow()] };
    if (text.includes("from public.token_candles")) return { rows: input.start === null ? [] : [input.start || startRow()] };
    if (text.includes("insert into public.robinhood_beat_market_metrics")) {
      input.capture?.push(params);
      return { rows: [] };
    }
    throw new Error(`Unexpected query in test: ${text.slice(0, 80)}`);
  };
}

test("derives and persists 24h Stock Battlefield relative performance from normalized evidence", async () => {
  const capture: unknown[][] = [];
  const result = await computeRobinhoodBeatTheMarket(
    { chainId: 46630, campaignAddress: CAMPAIGN, window: "24h", nowMs: NOW, persist: true },
    { query: queryFixture({ capture }) },
  );
  assert.equal(result.metric.healthy, true);
  if (!result.metric.healthy) return;
  assert.equal(result.metric.relativeReturn, "0.090909090909090909");
  assert.equal(result.metric.percentagePointDifference, "0.1");
  assert.equal((result as any).quoteTokenAddress, STOCK);
  assert.equal(capture.length, 1);
  assert.equal(capture[0][3], "24h");
  assert.equal(capture[0][12], "0.090909090909090909");
});

test("rejects direct-native Robinhood markets instead of comparing MEME against ETH as a Stock benchmark", async () => {
  const result = await computeRobinhoodBeatTheMarket(
    { chainId: 46630, campaignAddress: CAMPAIGN, window: "24h", nowMs: NOW, persist: false },
    { query: queryFixture({ current: currentRow({ quote_asset_type: "WRAPPED_NATIVE" }) }) },
  );
  assert.equal(result.metric.healthy, false);
  if (result.metric.healthy) return;
  assert.match(result.metric.error, /Stock Battlefield/i);
});

test("fails closed when current normalized valuation or Stock reference is stale", async () => {
  const result = await computeRobinhoodBeatTheMarket(
    { chainId: 46630, campaignAddress: CAMPAIGN, window: "24h", nowMs: NOW, persist: false },
    { query: queryFixture({ current: currentRow({ reference_price_updated_at: "2026-09-03T09:30:00.000Z" }) }) },
  );
  assert.equal(result.metric.healthy, false);
  if (result.metric.healthy) return;
  assert.match(result.metric.error, /stale/i);
});

test("fails closed when historical normalized boundary is missing", async () => {
  const result = await computeRobinhoodBeatTheMarket(
    { chainId: 46630, campaignAddress: CAMPAIGN, window: "24h", nowMs: NOW, persist: false },
    { query: queryFixture({ start: null }) },
  );
  assert.equal(result.metric.healthy, false);
  if (result.metric.healthy) return;
  assert.match(result.metric.error, /No healthy normalized/i);
});

test("rejects a historical boundary that is too sparse for ranked comparison", async () => {
  const result = await computeRobinhoodBeatTheMarket(
    { chainId: 46630, campaignAddress: CAMPAIGN, window: "24h", nowMs: NOW, persist: false },
    { query: queryFixture({ start: startRow({ bucket_start: "2026-09-02T07:00:00.000Z" }) }) },
  );
  assert.equal(result.metric.healthy, false);
  if (result.metric.healthy) return;
  assert.match(result.metric.error, /too sparse/i);
});

test("rejects non-Robinhood chains before querying any market data", async () => {
  let calls = 0;
  const result = await computeRobinhoodBeatTheMarket(
    { chainId: 56, campaignAddress: CAMPAIGN, window: "24h", nowMs: NOW, persist: false },
    { query: async () => { calls += 1; return { rows: [] }; } },
  );
  assert.equal(calls, 0);
  assert.equal(result.metric.healthy, false);
});
