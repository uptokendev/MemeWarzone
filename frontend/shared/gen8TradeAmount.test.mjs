import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { gen8FormatAmountField, gen8MaxCoinWei, gen8TypedAmountWei } from "./gen8TradeAmount.mjs";

const SOLD = 2_000_000_000_000_000n;
const BOUGHT = 9_656_964_904_134_925_090_398_129n;
const LEFT = BOUGHT - SOLD;

test("0.002 coins is exactly 2e15 wei, and MAX sends the wei written in the field", () => {
  assert.equal(gen8TypedAmountWei("0.002"), SOLD);
  assert.equal(gen8TypedAmountWei("0,002"), SOLD);
  assert.equal(gen8TypedAmountWei(" 0.002 "), SOLD);
  assert.equal(gen8TypedAmountWei("0.0020"), SOLD);
  assert.equal(gen8TypedAmountWei(""), null);
  assert.equal(gen8TypedAmountWei("0"), null);
  assert.equal(gen8TypedAmountWei("-1"), null);
  assert.equal(gen8TypedAmountWei("0.002 coins"), null);
  assert.equal(gen8FormatAmountField(SOLD), "0.002");
  assert.equal(gen8TypedAmountWei(gen8FormatAmountField(SOLD)), SOLD);
  assert.equal(gen8MaxCoinWei(LEFT, null), LEFT);
  assert.equal(gen8TypedAmountWei(gen8FormatAmountField(gen8MaxCoinWei(LEFT, null))), LEFT);
  const cap = 1_000_000_000_000_000_000n;
  assert.equal(gen8MaxCoinWei(LEFT, cap), cap);
  assert.equal(gen8TypedAmountWei(gen8FormatAmountField(cap)), cap);
  assert.equal(gen8MaxCoinWei(cap, LEFT), cap);
  assert.notEqual(gen8TypedAmountWei("0.002"), gen8TypedAmountWei("0.002") * 10n ** 18n);
  const panel = fs.readFileSync(new URL("../src/components/evm/Gen8TradePanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /Amount in coins/);
  assert.match(panel, /gen8TypedAmountWei\(amount, 18\)/);
  assert.match(panel, /gen8MaxCoinWei\(balances\.tokenRaw, maxSellable\)/);
  assert.match(panel, /gen8FormatAmountField\(cap, 18\)/);
  assert.doesNotMatch(panel, /parseUnitsSafe/);
  assert.doesNotMatch(panel, /formatUnits\(cap/);
});
