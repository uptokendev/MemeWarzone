import assert from "node:assert/strict";
import test from "node:test";
import { SOLANA_NATIVE_MINT, solanaPoolQuoteFromStats } from "./solanaPoolQuote.mjs";

test("no recorded quote, or WSOL, is a SOL pool", () => {
  assert.deepEqual(solanaPoolQuoteFromStats(null), { mint: SOLANA_NATIVE_MINT, symbol: "SOL", decimals: 9, native: true, referenceUsd: null });
  assert.deepEqual(solanaPoolQuoteFromStats({ dexQuoteMint: SOLANA_NATIVE_MINT, dexQuoteSymbol: "SOL" }).native, true);
});

test("a USDC pool reports its mint, symbol, decimals and USD reference", () => {
  const quote = solanaPoolQuoteFromStats({ dexQuoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", dexQuoteSymbol: "USDC", dexQuoteDecimals: 6, dexQuoteReferenceUsd: 1 });
  assert.deepEqual(quote, { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6, native: false, referenceUsd: 1 });
  const unknown = solanaPoolQuoteFromStats({ dexQuoteMint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" });
  assert.equal(unknown.symbol, "QUOTE");
  assert.equal(unknown.decimals, 6);
  assert.equal(unknown.referenceUsd, null);
});
