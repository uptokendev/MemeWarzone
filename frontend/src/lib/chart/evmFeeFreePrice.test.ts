// Run: npx tsx --test src/lib/chart/evmFeeFreePrice.test.ts
// Robinhood mainnet coin 0xe35aea83ccc7efd0604edc5dfd0962d9f6b7de60 (gen-7): production curve_trades rows.
import assert from "node:assert/strict";
import test from "node:test";
import {
  EVM_GEN6_LAUNCH_FEE_START_BPS,
  EVM_GEN7_LAUNCH_FEE_START_BPS,
  chartTradePrice,
  evmFeeFreeTradePrice,
  evmGrossFromEventAmount,
  evmTradeFeeBpsAt,
} from "./evmFeeFreePrice.ts";

const LAUNCH_AT = 1791640869;
const TRADE2 = {
  tokensWei: 267967622812168189246132n,
  costWei: 94225163475931n,
  grossRaw: "78783581501615",
  feeBps: 1960,
  blockTime: Date.parse("2026-10-10T14:01:57Z") / 1000,
};

test("gross_raw / tokens is the fill without the fee (RH 0xe35a trade 2: 2.94e-10, fill 3.52e-10)", () => {
  const price = evmFeeFreeTradePrice(TRADE2.grossRaw, TRADE2.tokensWei);
  assert.ok(price != null && Math.abs(price - 2.94004106e-10) < 1e-18);
  // pg numeric text and bigint both parse.
  assert.equal(evmFeeFreeTradePrice(`${TRADE2.grossRaw}.000`, TRADE2.tokensWei), price);
  assert.equal(evmFeeFreeTradePrice(BigInt(TRADE2.grossRaw), TRADE2.tokensWei), price);
  const fill = Number(TRADE2.costWei) / Number(TRADE2.tokensWei);
  assert.ok(fill / (price as number) > 1.19);
});

test("missing, zero or malformed gross_raw gives null, so the fill is used", () => {
  for (const value of [null, undefined, "", "0", "abc", "-5", "1.5"]) {
    assert.equal(evmFeeFreeTradePrice(value, 10n), null, String(value));
  }
  assert.equal(evmFeeFreeTradePrice("10", 0n), null);
});

test("the launch fee schedule matches the contract: gen-7 90% -> 2%, gen-6 50% -> 2% over 60 s", () => {
  assert.equal(evmTradeFeeBpsAt({ launchAt: 0, t: 0, baseFeeBps: 200, startBps: EVM_GEN7_LAUNCH_FEE_START_BPS }), 9000);
  assert.equal(evmTradeFeeBpsAt({ launchAt: 0, t: 30, baseFeeBps: 200, startBps: EVM_GEN6_LAUNCH_FEE_START_BPS }), 2600);
  assert.equal(evmTradeFeeBpsAt({ launchAt: 0, t: 60, baseFeeBps: 200, startBps: EVM_GEN7_LAUNCH_FEE_START_BPS }), 200);
  // The fee the indexer recorded for RH trade 2 (fee_bps 1960).
  assert.equal(
    evmTradeFeeBpsAt({ launchAt: LAUNCH_AT, t: TRADE2.blockTime, baseFeeBps: 200, startBps: EVM_GEN7_LAUNCH_FEE_START_BPS }),
    TRADE2.feeBps,
  );
});

test("inverting the event amount gives the indexer's gross_raw to within a wei", () => {
  const gross = evmGrossFromEventAmount("buy", TRADE2.costWei, TRADE2.feeBps);
  assert.ok(gross != null);
  const diff = (gross as bigint) - BigInt(TRADE2.grossRaw);
  assert.ok(diff >= -1n && diff <= 1n, `diff ${diff}`);
  // sell: payout = g - floor(g * bps / 1e4)
  const g = 1_000_000n;
  const payout = g - (g * 200n) / 10_000n;
  assert.equal(evmGrossFromEventAmount("sell", payout, 200), g);
  assert.equal(evmGrossFromEventAmount("sell", payout, 10_000), null);
});

test("chart price: fee-free first on EVM, the fill otherwise and always on Solana", () => {
  assert.equal(chartTradePrice({ pricePerToken: 3, feeFreePricePerToken: 2 }, false), 2);
  assert.equal(chartTradePrice({ pricePerToken: 3, feeFreePricePerToken: null }, false), 3);
  assert.equal(chartTradePrice({ pricePerToken: 3 }, false), 3);
  assert.equal(chartTradePrice({ pricePerToken: 3, feeFreePricePerToken: 2 }, true), 3);
  assert.equal(chartTradePrice({ pricePerToken: 0, feeFreePricePerToken: null }, false), null);
});
