import test from "node:test";
import assert from "node:assert/strict";
import {
  assertBnbMarketQuoteIdentity,
  assertBnbRequiredPools,
  buildBnbTopazBuyRoute,
  reverseBnbTopazRoute,
} from "./bnbTopazQuoteRouting.mjs";

const WBNB = "0x00000000000000000000000000000000000000a1";
const QUOTE = "0x00000000000000000000000000000000000000b2";
const MEME = "0x00000000000000000000000000000000000000c3";
const FACTORY = "0x00000000000000000000000000000000000000d4";
const FINAL = "0x00000000000000000000000000000000000000e5";
const ACQ = "0x00000000000000000000000000000000000000f6";

function nativeRoute() {
  return buildBnbTopazBuyRoute({
    wrappedNativeAddress: WBNB,
    quoteTokenAddress: WBNB,
    tokenAddress: MEME,
    factoryAddress: FACTORY,
  });
}

function quoteRoute() {
  return buildBnbTopazBuyRoute({
    wrappedNativeAddress: WBNB,
    quoteTokenAddress: QUOTE,
    tokenAddress: MEME,
    factoryAddress: FACTORY,
  });
}

test("native BUY remains WBNB -> MEME", () => {
  assert.deepEqual(nativeRoute().map(({ from, to }) => [from, to]), [[WBNB, MEME]]);
});

test("native SELL remains MEME -> WBNB", () => {
  assert.deepEqual(reverseBnbTopazRoute(nativeRoute()).map(({ from, to }) => [from, to]), [[MEME, WBNB]]);
});

test("non-native BUY is WBNB -> QUOTE -> MEME", () => {
  assert.deepEqual(quoteRoute().map(({ from, to }) => [from, to]), [[WBNB, QUOTE], [QUOTE, MEME]]);
});

test("non-native SELL reverses hop order MEME -> QUOTE -> WBNB", () => {
  assert.deepEqual(reverseBnbTopazRoute(quoteRoute()).map(({ from, to }) => [from, to]), [[MEME, QUOTE], [QUOTE, WBNB]]);
});

test("wrong quote identity fails closed", () => {
  assert.throws(
    () => assertBnbMarketQuoteIdentity({
      authoritativeQuoteToken: QUOTE,
      marketQuoteToken: "0x00000000000000000000000000000000000000aa",
      wrappedNativeAddress: WBNB,
    }),
    /quote identity mismatch/i,
  );
});

test("missing WBNB/QUOTE route fails closed", () => {
  assert.throws(
    () => assertBnbRequiredPools({
      finalPairAddress: FINAL,
      resolvedFinalPairAddress: FINAL,
      acquisitionPairAddress: "0x0000000000000000000000000000000000000000",
      quoteTokenAddress: QUOTE,
      wrappedNativeAddress: WBNB,
    }),
    /WBNB\/QUOTE.*unavailable/i,
  );
});

test("missing QUOTE/MEME route fails closed", () => {
  assert.throws(
    () => assertBnbRequiredPools({
      finalPairAddress: FINAL,
      resolvedFinalPairAddress: "0x0000000000000000000000000000000000000000",
      acquisitionPairAddress: ACQ,
      quoteTokenAddress: QUOTE,
      wrappedNativeAddress: WBNB,
    }),
    /QUOTE\/MEME.*unavailable/i,
  );
});

test("selected non-native quote cannot silently fall back to native final pair", () => {
  assert.throws(
    () => assertBnbRequiredPools({
      finalPairAddress: FINAL,
      resolvedFinalPairAddress: "0x00000000000000000000000000000000000000ab",
      acquisitionPairAddress: ACQ,
      quoteTokenAddress: QUOTE,
      wrappedNativeAddress: WBNB,
    }),
    /pool identity mismatch/i,
  );
});
