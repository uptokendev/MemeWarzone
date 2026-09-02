import test from "node:test";
import assert from "node:assert/strict";

import {
  formatPairExecution,
  normalizeCanonicalPairSwap,
  normalizeMockPairSwap,
  normalizePairDescriptor,
} from "../robinhoodPairSemantics.js";

const meme = "0x0000000000000000000000000000000000000011";
const weth = "0x0000000000000000000000000000000000000022";
const nvda = "0x0000000000000000000000000000000000000033";

test("native quote pairs remain WRAPPED_NATIVE", () => {
  const descriptor = normalizePairDescriptor({
    campaignTokenAddress: meme,
    token0Address: meme,
    token1Address: weth,
    wrappedNativeAddress: weth,
  });
  assert.equal(descriptor.baseTokenAddress, meme.toLowerCase());
  assert.equal(descriptor.quoteTokenAddress, weth.toLowerCase());
  assert.equal(descriptor.quoteAssetType, "WRAPPED_NATIVE");
});

test("registered stock quote pairs are classified as STOCK_TOKEN", () => {
  const descriptor = normalizePairDescriptor({
    campaignTokenAddress: meme,
    token0Address: nvda,
    token1Address: meme,
    wrappedNativeAddress: weth,
    stockTokenAddresses: [nvda],
    quoteDecimals: 8,
  });
  assert.equal(descriptor.baseTokenAddress, meme.toLowerCase());
  assert.equal(descriptor.quoteTokenAddress, nvda.toLowerCase());
  assert.equal(descriptor.quoteAssetType, "STOCK_TOKEN");
  assert.equal(descriptor.quoteDecimals, 8);
});

test("mock V3 stock->meme is a buy denominated in quote units", () => {
  const descriptor = normalizePairDescriptor({
    campaignTokenAddress: meme,
    token0Address: meme,
    token1Address: nvda,
    wrappedNativeAddress: weth,
    stockTokenAddresses: [nvda],
    baseDecimals: 18,
    quoteDecimals: 8,
  });
  const swap = normalizeMockPairSwap({
    descriptor,
    tokenIn: nvda,
    tokenOut: meme,
    amountIn: 250_000_000n,
    amountOut: 10_000_000_000_000_000_000n,
  });
  assert.ok(swap);
  assert.equal(swap.side, "buy");
  assert.equal(swap.baseAmountRaw, 10_000_000_000_000_000_000n);
  assert.equal(swap.quoteAmountRaw, 250_000_000n);
  assert.deepEqual(formatPairExecution({ descriptor, swap }), {
    baseAmount: "10",
    quoteAmount: "2.5",
    priceQuote: "0.25",
  });
});

test("canonical V3 deltas work for stock-token quote assets", () => {
  const descriptor = normalizePairDescriptor({
    campaignTokenAddress: meme,
    token0Address: nvda,
    token1Address: meme,
    wrappedNativeAddress: weth,
    stockTokenAddresses: [nvda],
  });
  const swap = normalizeCanonicalPairSwap({
    descriptor,
    token0Address: nvda,
    amount0: 1_000_000_000_000_000_000n,
    amount1: -4_000_000_000_000_000_000n,
  });
  assert.ok(swap);
  assert.equal(swap.side, "buy");
  assert.equal(swap.baseAmountRaw, 4_000_000_000_000_000_000n);
  assert.equal(swap.quoteAmountRaw, 1_000_000_000_000_000_000n);
});

test("foreign pools fail closed", () => {
  assert.throws(
    () => normalizePairDescriptor({
      campaignTokenAddress: meme,
      token0Address: weth,
      token1Address: nvda,
      wrappedNativeAddress: weth,
      stockTokenAddresses: [nvda],
    }),
    /does not contain campaign token/,
  );
});
