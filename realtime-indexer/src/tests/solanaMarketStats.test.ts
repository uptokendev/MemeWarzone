import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:5432/test";
process.env.ABLY_API_KEY ||= "test:key";
process.env.SOLANA_RPC_HTTP ||= "http://127.0.0.1:8899";

const { HOLDER_COUNT_SQL, computeSolanaMarketStats } = await import("../solanaMarketStats.js");
type SolanaMarketStatsInputs = import("../solanaMarketStats.js").SolanaMarketStatsInputs;

const NATIVE = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOW = Date.parse("2026-09-22T00:00:00Z");
const close = (actual: unknown, expected: number, label?: string) => assert.ok(Math.abs(Number(actual) - expected) < 1e-6, `${label || "value"}: ${actual} != ${expected}`);

function base(overrides: Partial<SolanaMarketStatsInputs> = {}): SolanaMarketStatsInputs {
  return {
    campaign: "Camp", tokenAddress: "Mint", graduated: true, quoteMint: NATIVE, quoteDecimals: 9,
    priceQuote: 0.00001, quoteUsd: 150, quoteUsdSource: "coingecko:solana", quoteUsdUpdatedAt: new Date(NOW),
    supplyWhole: 700_000_000, tokenReserveWhole: 200_000_000, quoteReserveWhole: 2_000,
    volumes: { m5: 1, h1: 5, h4: 20, h24: 100, buy24: 60, sell24: 40, bonding24: 0, dex24: 100, trades24: 12, buys24: 7, sells24: 5 },
    volumeUsd24h: 15_000, holders: 42, lastTradeAt: new Date(NOW - 90_000), lastTradeBlock: 123, nowMs: NOW,
    ...overrides,
  };
}

test("SOL pool: USD derives from SOL/USD, native columns stay filled, liquidity values both sides", () => {
  const row = computeSolanaMarketStats(base());
  assert.equal(row.market_stage, "DEX_ACTIVE");
  assert.equal(row.quote_asset_type, "WRAPPED_NATIVE");
  assert.equal(row.last_price_bnb, 0.00001);
  assert.equal(row.last_price_usd, 0.0015);
  close(row.market_cap_bnb, 7_000, "market_cap_bnb");
  close(row.market_cap_usd, 1_050_000, "market_cap_usd");
  close(row.liquidity_bnb, 2_000 + 200_000_000 * 0.00001, "liquidity_bnb");
  close(row.liquidity_usd, (2_000 + 2_000) * 150, "liquidity_usd");
  assert.equal(row.volume_24h_bnb, 100);
  assert.equal(row.volume_24h_usd, 15_000);
  assert.equal(row.holders, 42);
  assert.equal(row.data_lag_seconds, 90);
  assert.equal(row.valuation_healthy, true);
  assert.equal(row.supply_basis, "bonding_sold_tokens");
});

test("USDC pool: MEME/USD = MEME/QUOTE x QUOTE/USD, no SOL columns, quote type OTHER", () => {
  const row = computeSolanaMarketStats(base({ quoteMint: USDC, quoteDecimals: 6, priceQuote: 0.002, quoteUsd: 1, quoteUsdSource: "catalog_reference_usd", tokenReserveWhole: 100_000_000, quoteReserveWhole: 50_000 }));
  assert.equal(row.quote_asset_type, "OTHER");
  assert.equal(row.quote_token_address, USDC);
  assert.equal(row.last_price_bnb, null);
  assert.equal(row.market_cap_bnb, null);
  assert.equal(row.volume_24h_bnb, 0);
  assert.equal(row.last_price_quote, 0.002);
  assert.equal(row.last_price_usd, 0.002);
  close(row.market_cap_usd, 1_400_000, "market_cap_usd");
  close(row.liquidity_usd, 50_000 + 100_000_000 * 0.002, "liquidity_usd");
  assert.equal(row.reference_price_usd, 1);
  assert.equal(row.valuation_source, "catalog_reference_usd");
  assert.equal(row.valuation_healthy, true);
});

test("bonding curve: stage BONDING, reserve is the SOL vault, one-sided liquidity", () => {
  const row = computeSolanaMarketStats(base({ graduated: false, tokenReserveWhole: null, quoteReserveWhole: 12.5, volumes: { ...base().volumes, bonding24: 100, dex24: 0 } }));
  assert.equal(row.market_stage, "BONDING");
  assert.equal(row.bonding_reserve_bnb, 12.5);
  assert.equal(row.liquidity_bnb, 12.5);
  close(row.liquidity_usd, 12.5 * 150, "liquidity_usd");
  assert.equal(row.bonding_volume_24h_bnb, 100);
  assert.equal(row.dex_volume_24h_quote, 0);
});

test("missing prices make the row unhealthy but still record holders and stage", () => {
  const noSol = computeSolanaMarketStats(base({ quoteUsd: null, quoteUsdSource: "coingecko:solana", quoteUsdUpdatedAt: null }));
  assert.equal(noSol.valuation_healthy, false);
  assert.equal(noSol.last_price_usd, null);
  assert.equal(noSol.market_cap_usd, null);
  close(noSol.market_cap_bnb, 7_000, "native-unit market cap still known");
  assert.match(String(noSol.valuation_error), /SOL\/USD reference unavailable/);
  assert.equal(noSol.holders, 42);
  const noPrice = computeSolanaMarketStats(base({ priceQuote: null }));
  assert.equal(noPrice.valuation_healthy, false);
  assert.match(String(noPrice.valuation_error), /no launch token price yet/);
});

test("holder count comes from the trade ledger, counting wallets with a positive net balance", () => {
  assert.match(HOLDER_COUNT_SQL, /from public\.curve_trades/);
  assert.match(HOLDER_COUNT_SQL, /from public\.dex_trades/);
  assert.match(HOLDER_COUNT_SQL, /where balance > 0/);
  assert.match(HOLDER_COUNT_SQL, /status = 'confirmed'/);
});
