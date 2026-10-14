import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPartnerTokenStats,
  createTtlCache,
  isPartnerOrigin,
  normalizePartnerAddress,
  parsePartnerChainId,
  partnerOrigins,
  type PartnerStatsRow,
} from "../partnerTokenStats.js";

const K88_MINT = "4VPtpo5qQmmbva9JHYU2eiH9UY6Xf32nCbKKB5ZeYb77";

function row(overrides: Partial<PartnerStatsRow> = {}): PartnerStatsRow {
  return {
    chain_id: 101,
    campaign_address: "Hsa3rJRQHVs8hB9psXipLjRz66kKr9Nhcrc8wGmH9edA",
    token_address: K88_MINT,
    name: "KAIJU88",
    symbol: "K88",
    market_stage: "BONDING",
    last_price_bnb: "0.00000022450330589238918",
    last_price_usd: "0.000025097224565710188",
    market_cap_usd: "6599.191363717539",
    volume_24h_usd: "33.74310811732",
    liquidity_usd: "3314.4116720134703",
    holders: 42,
    trades_24h: 1,
    last_trade_at: new Date("2026-10-11T00:37:42.000Z"),
    updated_at: "2026-10-11T16:09:38.127Z",
    valuation_healthy: true,
    price_24h_ago: "0.0000002245",
    ...overrides,
  };
}

test("partner origins: crypticpump by default, env extras trimmed, nothing else", () => {
  const allowed = partnerOrigins(" https://partner.example/ ,");
  assert.equal(isPartnerOrigin("https://crypticpump.com", allowed), true);
  assert.equal(isPartnerOrigin("https://www.crypticpump.com", allowed), true);
  assert.equal(isPartnerOrigin("https://partner.example", allowed), true);
  assert.equal(isPartnerOrigin("http://crypticpump.com", allowed), false);
  assert.equal(isPartnerOrigin("https://evil-crypticpump.com", allowed), false);
  assert.equal(isPartnerOrigin("https://crypticpump.com.evil.io", allowed), false);
  assert.equal(isPartnerOrigin(undefined, allowed), false);
});

test("chain id and address validation", () => {
  assert.equal(parsePartnerChainId("101"), 101);
  assert.equal(parsePartnerChainId("56"), 56);
  assert.equal(parsePartnerChainId("102"), null);
  assert.equal(parsePartnerChainId(undefined), null);
  assert.equal(normalizePartnerAddress(101, K88_MINT), K88_MINT);
  assert.equal(normalizePartnerAddress(101, "0OIl"), null);
  assert.equal(normalizePartnerAddress(56, "0xABCDEF0123456789abcdef0123456789ABCDEF01"), "0xabcdef0123456789abcdef0123456789abcdef01");
  assert.equal(normalizePartnerAddress(56, K88_MINT), null);
});

test("stats shape for K88: USD fields, price per 1M, 24h change, page url", () => {
  const stats = buildPartnerTokenStats(row());
  assert.equal(stats.chainId, 101);
  assert.equal(stats.tokenAddress, K88_MINT);
  assert.equal(stats.symbol, "K88");
  assert.equal(stats.stage, "BONDING");
  assert.equal(stats.priceUsd, 0.000025097224565710188);
  assert.ok(Math.abs((stats.pricePer1mUsd ?? 0) - 25.097224565710188) < 1e-9);
  assert.equal(stats.marketCapUsd, 6599.191363717539);
  assert.equal(stats.volume24hUsd, 33.74310811732);
  assert.equal(stats.holders, 42);
  assert.equal(stats.trades24h, 1);
  assert.ok(Math.abs((stats.priceChange24hPct ?? 0) - (0.00000022450330589238918 / 0.0000002245 - 1) * 100) < 1e-9);
  assert.equal(stats.lastTradeAt, "2026-10-11T00:37:42.000Z");
  assert.equal(stats.updatedAt, "2026-10-11T16:09:38.127Z");
  assert.equal(stats.pageUrl, `https://app.memewar.zone/token/${K88_MINT}`);
  assert.equal(stats.source, "Meme Warzone");
  assert.equal("lastError" in stats, false);
});

test("unhealthy valuation withholds USD figures but keeps counts and change", () => {
  const stats = buildPartnerTokenStats(row({ valuation_healthy: false }));
  assert.equal(stats.priceUsd, null);
  assert.equal(stats.pricePer1mUsd, null);
  assert.equal(stats.marketCapUsd, null);
  assert.equal(stats.volume24hUsd, null);
  assert.equal(stats.liquidityUsd, null);
  assert.equal(stats.holders, 42);
  assert.notEqual(stats.priceChange24hPct, null);
});

test("missing market stats row gives nulls, not NaN", () => {
  const stats = buildPartnerTokenStats(
    row({
      market_stage: null, last_price_bnb: null, last_price_usd: null, market_cap_usd: null,
      volume_24h_usd: null, liquidity_usd: null, holders: null, trades_24h: null,
      last_trade_at: null, updated_at: null, valuation_healthy: null, price_24h_ago: null,
    }),
  );
  assert.equal(stats.stage, "BONDING");
  assert.equal(stats.priceUsd, null);
  assert.equal(stats.priceChange24hPct, null);
  assert.equal(stats.holders, null);
  assert.equal(stats.updatedAt, null);
});

test("ttl cache expires and evicts oldest", () => {
  let clock = 0;
  const cache = createTtlCache<number>(1000, 2, () => clock);
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  clock = 1000;
  assert.equal(cache.get("c"), undefined);
  assert.equal(cache.size(), 1);
});
