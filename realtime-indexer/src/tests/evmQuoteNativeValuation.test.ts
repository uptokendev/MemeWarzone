import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  nativePerQuoteFromReserves,
  nativePerQuoteFromUsd,
  quotePriceToNative,
  quoteRawToNativeRaw,
  quoteRawToNativeRawViaReserves,
  quoteWadRatioToNativeWad,
  rawRatioToWholePrice,
  rawToDecimal,
} from "../evmQuoteNativeValuation.js";
import { isNativePairedPool, normalizeTopazSwap, pairedTokenOf, priceBnbFromRaw } from "../topazPoolCore.js";

const E18 = 10n ** 18n;
const E6 = 10n ** 6n;
const MEME = "0x1111111111111111111111111111111111111111";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const USDT = "0x55d398326f99059ff775485246999027b3197955";

// quote/WBNB pool: 600,000 quote vs 1,000 WBNB -> 1 quote = 1/600 BNB (BNB at $600).
const usdtReserves18 = { reserveQuoteRaw: 600_000n * E18, reserveNativeRaw: 1_000n * E18 };
const usdcReserves6 = { reserveQuoteRaw: 600_000n * E6, reserveNativeRaw: 1_000n * E18 };

test("pool pairing: MEME/WBNB is native, MEME/USDT is a quote pool whatever the token order", () => {
  assert.equal(isNativePairedPool({ tokenAddress: MEME, token0Address: MEME, token1Address: WBNB, wrappedNativeAddress: WBNB }), true);
  assert.equal(isNativePairedPool({ tokenAddress: MEME, token0Address: WBNB, token1Address: MEME, wrappedNativeAddress: WBNB }), true);
  assert.equal(isNativePairedPool({ tokenAddress: MEME, token0Address: MEME, token1Address: USDT, wrappedNativeAddress: WBNB }), false);
  assert.equal(pairedTokenOf({ tokenAddress: MEME, token0Address: USDT, token1Address: MEME }), USDT);
});

test("USDT (18 decimals) paired trade: native amount and price are BNB, quote leg kept", () => {
  // Buy: 60 USDT in, 1,000,000 MEME out. MEME is token1.
  const swap = normalizeTopazSwap(false, { amount0In: 60n * E18, amount1In: 0n, amount0Out: 0n, amount1Out: 1_000_000n * E18 });
  assert.ok(swap);
  assert.equal(swap.side, "buy");
  const quoteRaw = swap.nativeAmountRaw; // the paired leg, in quote units
  const nativeRaw = quoteRawToNativeRawViaReserves({ quoteAmountRaw: quoteRaw, ...usdtReserves18 });
  assert.equal(nativeRaw, E18 / 10n); // 60 USDT = 0.1 BNB
  assert.equal(priceBnbFromRaw(swap.tokenAmountRaw, nativeRaw!, 18, 18), "0.0000001");
  assert.equal(priceBnbFromRaw(swap.tokenAmountRaw, quoteRaw, 18, 18), "0.00006");
  assert.equal(rawToDecimal(quoteRaw, 18), "60");
});

test("6-decimal quote: never assumes 18 decimals", () => {
  const quoteRaw = 60n * E6; // 60 USDC
  const nativeRaw = quoteRawToNativeRawViaReserves({ quoteAmountRaw: quoteRaw, ...usdcReserves6 });
  assert.equal(nativeRaw, E18 / 10n);
  assert.equal(priceBnbFromRaw(1_000_000n * E18, nativeRaw!, 18, 18), "0.0000001");
  // Price in quote needs the quote's real decimals.
  assert.equal(priceBnbFromRaw(1_000_000n * E18, quoteRaw, 18, 6), "0.00006");
  assert.equal(rawToDecimal(quoteRaw, 6), "60");

  // Whole native per whole quote is the same 1/600 for both decimal layouts.
  const rate18 = nativePerQuoteFromReserves({ ...usdtReserves18, quoteDecimals: 18 });
  const rate6 = nativePerQuoteFromReserves({ ...usdcReserves6, quoteDecimals: 6 });
  assert.equal(rate18, rate6);
  assert.match(String(rate6), /^0\.0016666666/);
  // The rate path and the reserves path agree (to the rate's 36-digit precision).
  const viaRate = quoteRawToNativeRaw({ quoteAmountRaw: quoteRaw, quoteDecimals: 6, nativePerQuote: rate6 });
  assert.ok(viaRate != null && E18 / 10n - viaRate <= 1n);
});

test("graduation start price (raw paired/MEME ratio x 1e18) becomes native for 18- and 6-decimal quotes", () => {
  // 0.00006 quote per MEME.
  const startWad18 = 6n * 10n ** 13n; // 6e-5 * 1e18 (both 18 decimals)
  const startWad6 = 60n; // 6e-5 * 1e6 / 1e18 * 1e18
  assert.equal(quoteWadRatioToNativeWad({ ratioWad: startWad18, ...usdtReserves18 }), 10n ** 11n); // 1e-7 BNB
  assert.equal(quoteWadRatioToNativeWad({ ratioWad: startWad6, ...usdcReserves6 }), 10n ** 11n);
  assert.equal(rawRatioToWholePrice("0.00006", 18, 18), "0.00006");
  assert.equal(rawRatioToWholePrice("0.00000000000000006", 18, 6), "0.00006");
});

test("Robinhood stock-paired trade: stock USD / ETH USD gives ETH values", () => {
  // NVDA $180, ETH $3,600 -> 0.05 ETH per share token.
  const rate = nativePerQuoteFromUsd("180", "3600");
  assert.equal(rate, "0.05");
  // 2 stock tokens (18 decimals) -> 0.1 ETH; the same with a 6-decimal stock token.
  assert.equal(quoteRawToNativeRaw({ quoteAmountRaw: 2n * E18, quoteDecimals: 18, nativePerQuote: rate }), E18 / 10n);
  assert.equal(quoteRawToNativeRaw({ quoteAmountRaw: 2n * E6, quoteDecimals: 6, nativePerQuote: rate }), E18 / 10n);
  // 0.00002 stock per MEME -> 0.000001 ETH per MEME.
  assert.equal(quotePriceToNative("0.00002", rate), "0.000001");
  assert.equal(rawToDecimal(E18 / 10n, 18), "0.1");
});

test("unusable inputs yield null, never a guessed number", () => {
  assert.equal(nativePerQuoteFromUsd(null, "3600"), null);
  assert.equal(nativePerQuoteFromUsd("180", "0"), null);
  assert.equal(nativePerQuoteFromReserves({ reserveQuoteRaw: 0n, reserveNativeRaw: E18, quoteDecimals: 18 }), null);
  assert.equal(quoteRawToNativeRawViaReserves({ quoteAmountRaw: 1n, reserveQuoteRaw: 0n, reserveNativeRaw: E18 }), null);
  assert.equal(quoteRawToNativeRaw({ quoteAmountRaw: 1n, quoteDecimals: 99, nativePerQuote: "1" }), null);
  assert.equal(quotePriceToNative("abc", "1"), null);
});

test("migration keeps an explicit quote leg and only mirrors native for native-paired trades", async () => {
  const sql = await readFile(
    new URL("../../../db/migrations/20260930_000003_dex_trade_quote_leg_preserved.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /create or replace function public\.set_dex_trade_quote_identity\(\)/i);
  assert.match(sql, /if new\.quote_token_address is null or new\.quote_token_address='' then\s+new\.quote_token_address := v_pool_quote/i);
  assert.match(sql, /if new\.quote_amount_raw is null[\s\S]*lower\(new\.quote_token_address\)=lower\(coalesce\(v_wrapped,''\)\) then\s+new\.quote_amount_raw := new\.native_amount_raw/i);
  assert.doesNotMatch(sql, /create trigger/i);
});
