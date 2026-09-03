import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRobinhoodStockGraduationRegistry,
  resolveRobinhoodStockGraduationAsset,
} from "./robinhoodStockCreatePolicy.js";

const STOCK = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";

function registry(overrides = {}) {
  return JSON.stringify([
    {
      contractAddress: STOCK,
      symbol: "NVDA",
      displayName: "NVIDIA Stock Token",
      underlyingSymbol: "NVDA",
      canonical: true,
      enabledForGraduation: true,
      ...overrides,
    },
  ]);
}

test("selects only canonical Stock Tokens enabled for graduation", () => {
  const asset = resolveRobinhoodStockGraduationAsset({ chainId: 46630, stockToken: STOCK, rawRegistry: registry() });
  assert.equal(asset.contractAddress.toLowerCase(), STOCK.toLowerCase());
  assert.equal(asset.symbol, "NVDA");
  assert.equal(asset.canonical, true);
  assert.equal(asset.enabledForGraduation, true);

  assert.throws(
    () => resolveRobinhoodStockGraduationAsset({ chainId: 46630, stockToken: OTHER, rawRegistry: registry() }),
    /not canonical and enabled/,
  );
  assert.throws(
    () => resolveRobinhoodStockGraduationAsset({ chainId: 46630, stockToken: STOCK, rawRegistry: registry({ canonical: false }) }),
    /not canonical and enabled/,
  );
  assert.throws(
    () => resolveRobinhoodStockGraduationAsset({ chainId: 46630, stockToken: STOCK, rawRegistry: registry({ enabledForGraduation: false }) }),
    /not canonical and enabled/,
  );
});

test("local Robinhood rehearsal reads the 46630 policy shape and malformed registry fails closed", () => {
  assert.equal(parseRobinhoodStockGraduationRegistry({ chainId: 31337, rawRegistry: registry() }).length, 1);
  assert.throws(
    () => parseRobinhoodStockGraduationRegistry({ chainId: 46630, rawRegistry: "{" }),
    /not valid JSON/,
  );
});
