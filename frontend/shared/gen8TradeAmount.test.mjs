import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { gen8FormatAmountField, gen8MaxCoinWei, gen8ScaleSellCoins, gen8SpotSellCoins, gen8TypedAmountWei } from "./gen8TradeAmount.mjs";

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
  assert.match(panel, /Amount in \$\{native\}/);
  assert.match(panel, /useState<"BNB" \| "TOKEN">\("BNB"\)/);
  assert.match(panel, /gen8TypedAmountWei\(amount, 18\)/);
  assert.match(panel, /gen8MaxCoinWei\(balances\.tokenRaw, maxSellable\)/);
  assert.match(panel, /gen8FormatAmountField\(cap, 18\)/);
  assert.match(panel, /gen8SpotSellCoins\(/);
  assert.match(panel, /gen8ScaleSellCoins\(/);
  assert.match(panel, /amountIn: tradeAmountIn/);
  assert.match(panel, /data-gen8-sell-coins/);
  assert.doesNotMatch(panel, /amountIn: amountRaw/);
  assert.doesNotMatch(panel, /parseUnitsSafe/);
  assert.doesNotMatch(panel, /formatUnits\(cap/);
});

test("0.002 BNB at the YCC spot is millions of coins, not 0.002 coins", () => {
  const target = 2_000_000_000_000_000n;
  const priceWei = 455_183_624n;
  const coins = gen8SpotSellCoins({ targetNativeWei: target, nativePerCoinWei: priceWei, feeBps: 100 });
  assert.ok(coins != null);
  assert.notEqual(coins, target);
  assert.ok(coins > 1_000_000n * 10n ** 18n);
  const quotedOut = (coins * priceWei) / 10n ** 18n;
  const scaled = gen8ScaleSellCoins({ coinIn: coins, quotedOut, targetOut: target });
  assert.ok(scaled != null && scaled > 0n);
  assert.equal(gen8ScaleSellCoins({ coinIn: 2_000n, quotedOut: 500n, targetOut: 1_000n }), 4_000n);
  assert.equal(gen8ScaleSellCoins({ coinIn: 2_000n, quotedOut: 1_000n, targetOut: 1_000n }), 2_000n);
  assert.equal(gen8ScaleSellCoins({ coinIn: 2_000n, quotedOut: 0n, targetOut: 1_000n }), null);
  assert.equal(gen8SpotSellCoins({ targetNativeWei: 0n, nativePerCoinWei: priceWei, feeBps: 100 }), null);
});
