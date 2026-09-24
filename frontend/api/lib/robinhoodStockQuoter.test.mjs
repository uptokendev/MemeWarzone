import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { resolveStockQuoterAddress } from "./robinhoodStockRuntimeCertification.js";

test("a configured quoter is read per chain, server name first, then the app's VITE name; anything else is no quoter", () => {
  const q = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
  assert.equal(resolveStockQuoterAddress(4663, { ROBINHOOD_V3_QUOTER_ADDRESS_4663: q.toLowerCase() }), q);
  assert.equal(resolveStockQuoterAddress(4663, { VITE_ROBINHOOD_V3_QUOTER_ADDRESS_4663: q }), q);
  assert.equal(resolveStockQuoterAddress(4663, { ROBINHOOD_V3_QUOTER_ADDRESS_4663: "0xbad", VITE_ROBINHOOD_V3_QUOTER_ADDRESS_4663: q }), q, "a malformed server value does not hide a valid app value");
  assert.equal(resolveStockQuoterAddress(4663, { ROBINHOOD_V3_QUOTER_ADDRESS_46630: q }), "");
  assert.equal(resolveStockQuoterAddress(4663, {}), "");
});

test("certification quotes through the configured quoter (QuoterV2 struct, then v1 shape) and only falls back to the mock-style router", () => {
  const source = fs.readFileSync(new URL("./robinhoodStockRuntimeCertification.js", import.meta.url), "utf8");
  assert.match(source, /const quoterAddress = resolveStockQuoterAddress\(chainId\);/);
  assert.match(source, /v2\.quoteExactInputSingle\.staticCall\(\{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n \}\)/);
  assert.match(source, /v1\.quoteExactInputSingle\.staticCall\(tokenIn, tokenOut, fee, amountIn, 0n\)/);
  assert.match(source, /router\.quoteExactInputSingle\(tokenIn, tokenOut, fee, amountIn\)/);
  const trade = fs.readFileSync(new URL("../../src/lib/robinhoodV3Trade.ts", import.meta.url), "utf8");
  assert.match(trade, /V3_QUOTER_V2_ABI/);
  assert.match(trade, /quoterV2\.quoteExactInputSingle\.staticCall\(\{ tokenIn, tokenOut, amountIn: amountInRaw, fee: route\.fee, sqrtPriceLimitX96: 0n \}\)/);
});
