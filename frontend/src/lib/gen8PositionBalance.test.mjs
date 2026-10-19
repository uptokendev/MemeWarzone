import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Your Position reads the gen-8 coin balance and refreshes when the pool price moves", () => {
  const page = fs.readFileSync(new URL("../pages/TokenDetails.tsx", import.meta.url), "utf8");
  assert.match(page, /GEN8_ERC20_BALANCE_ABI/);
  assert.match(page, /const tokenAddress = gen8State\?\.token \|\| campaign\?\.token/);
  assert.match(page, /const abi = gen8State \? GEN8_ERC20_BALANCE_ABI : TOKEN_ABI/);
  assert.match(page, /gen8State \? latestTradeKey : ""/);
  assert.match(page, /gen8State\?\.market\?\.sqrtPriceX96/);
  assert.match(page, /gen8FormatAmount\(tokenBalanceWei\)/);
});
