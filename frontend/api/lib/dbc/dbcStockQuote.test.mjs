import assert from "node:assert/strict";
import test from "node:test";
import {
  assertStockQuoteUsable,
  effectiveMultiplier,
  readJupiterStockPrice,
  stockPriceStep,
  stockUsdMicrosPerRawUnit,
} from "./dbcStockQuote.mjs";
import { findQuote, NVDAX_MINT } from "../../../shared/dbcQuotes.mjs";

const USABLE = {
  decimals: 8, multiplier: 1.0017, paused: false, hookProgram: null, transferFeeBps: 0, badgeExists: true, dammBadgeExists: true,
};

test("the multiplier in force switches at its effective time", () => {
  const scaled = { multiplier: 1.0009, newMultiplier: 1.0017, newMultiplierEffectiveTimestamp: 1789000200n };
  assert.equal(effectiveMultiplier(scaled, 1789000199), 1.0009);
  assert.equal(effectiveMultiplier(scaled, 1789000200), 1.0017);
  assert.equal(effectiveMultiplier(null, 0), 1);
});

test("a stock is refused for each issuer power that breaks the curve or the pool", () => {
  assert.doesNotThrow(() => assertStockQuoteUsable(USABLE));
  const cases = [
    [{ badgeExists: false }, "DBC_QUOTE_NO_BADGE"],
    [{ dammBadgeExists: false }, "DBC_QUOTE_NO_BADGE"],
    [{ paused: true }, "DBC_QUOTE_PAUSED"],
    [{ hookProgram: "Hook111" }, "DBC_QUOTE_HOOK"],
    [{ transferFeeBps: 1 }, "DBC_QUOTE_TRANSFER_FEE"],
  ];
  for (const [change, code] of cases) {
    assert.throws(() => assertStockQuoteUsable({ ...USABLE, ...change }), (err) => err.code === code && err.httpStatus === 400);
  }
});

test("price per 10^8 raw = displayed price x multiplier, cross-checked against Jupiter's prescaled price", () => {
  assert.equal(stockUsdMicrosPerRawUnit({ usdPrice: 230.717, usdPricePrescaled: 231.109 }, 1.001701), 231_109_450n);
  assert.throws(() => stockUsdMicrosPerRawUnit({ usdPrice: 230.717, usdPricePrescaled: 240 }, 1.0017), /multiplier/);
  assert.throws(() => stockUsdMicrosPerRawUnit({ usdPrice: 0 }, 1), /No price/);
});

test("Jupiter reader: price and prescaled price; no row or a bad status is no price", async () => {
  const body = { [NVDAX_MINT]: { usdPrice: 230.7, scaledUiConfig: { usdPricePrescaled: 231.1 } } };
  const ok = async () => ({ ok: true, json: async () => body });
  assert.deepEqual(await readJupiterStockPrice(NVDAX_MINT, { fetchImpl: ok }), { usdPrice: 230.7, usdPricePrescaled: 231.1 });
  assert.equal(await readJupiterStockPrice(NVDAX_MINT, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), null);
  assert.equal(await readJupiterStockPrice(NVDAX_MINT, { fetchImpl: async () => ({ ok: false }) }), null);
});

test("stockPriceStep refuses before pricing when the mint is not usable", async () => {
  const nvda = findQuote("mainnet-beta", NVDAX_MINT);
  let priced = false;
  const fetchImpl = async () => { priced = true; return { ok: false }; };
  // an account that is not a Token-2022 mint cannot be read as one
  const connection = { async getAccountInfo() { return null; }, async getMultipleAccountsInfo() { return [null, null]; } };
  await assert.rejects(() => stockPriceStep(connection, nvda, { fetchImpl }));
  assert.equal(priced, false);
});
