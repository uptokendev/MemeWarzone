import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  engineAmountFromDisplay,
  mobileDockCta,
  mobileTradeCta,
  mobileTradeUnitLabel,
  nextMobileTradeUnit,
  percentOf,
  usdToNativeAmount,
  usdToTokenAmount,
} from "./mobileTradePresentation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("unit switcher cycles USD → native → token", () => {
  assert.equal(nextMobileTradeUnit("USD"), "NATIVE");
  assert.equal(nextMobileTradeUnit("NATIVE"), "TOKEN");
  assert.equal(nextMobileTradeUnit("TOKEN"), "USD");
  assert.equal(mobileTradeUnitLabel("USD", "SOL", "YAP"), "USD");
  assert.equal(mobileTradeUnitLabel("NATIVE", "SOL", "YAP"), "SOL");
  assert.equal(mobileTradeUnitLabel("TOKEN", "SOL", "$YAP"), "YAP");
});

test("USD buy converts to native for the existing trade engine", () => {
  assert.equal(usdToNativeAmount(150, 150), "1");
  const engine = engineAmountFromDisplay({ unit: "USD", displayAmount: "25", side: "buy", nativeUsd: 125, priceNative: 0.0001 });
  assert.equal(engine.denom, "BNB");
  assert.ok(Number(engine.amount) > 0);
});

test("USD sell converts to tokens for the existing trade engine", () => {
  const engine = engineAmountFromDisplay({
    unit: "USD",
    displayAmount: "25",
    side: "sell",
    nativeUsd: 100,
    priceNative: 0.001,
  });
  assert.equal(engine.denom, "TOKEN");
  assert.ok(Number(engine.amount) > 0);
  assert.equal(usdToTokenAmount(10, 0.001, 100), "100");
});

test("CTA copy matches the Pump-style empty and connected states", () => {
  assert.equal(mobileDockCta({ connected: false, connectLabel: "Connect SOL wallet" }).label, "Connect SOL wallet");
  assert.equal(mobileDockCta({ connected: true }).label, "Buy");
  assert.equal(mobileTradeCta({ connected: true, displayAmount: "" }).label, "Enter an amount");
  assert.equal(mobileTradeCta({ connected: true, displayAmount: "0" }).disabled, true);
  assert.equal(mobileTradeCta({ connected: true, displayAmount: "25", side: "buy" }).label, "Buy");
  assert.equal(mobileTradeCta({ connected: true, displayAmount: "25", side: "sell" }).label, "Sell");
  assert.equal(percentOf(2, 50), "1");
});

test("TokenDetails mounts the mobile dock and hides the inline trade tabs on small screens", () => {
  const page = fs.readFileSync(path.join(here, "../pages/TokenDetails.tsx"), "utf8");
  const sheet = fs.readFileSync(path.join(here, "../components/token/MobileTradeSheet.tsx"), "utf8");
  assert.match(page, /MobileTradeDock/);
  assert.match(page, /MobileTradeSheet/);
  assert.match(page, /hidden xl:block/);
  assert.match(page, /pb-24 xl:pb-0/);
  assert.match(sheet, /data-mobile-trade-dock/);
  assert.match(sheet, /data-mobile-trade-unit/);
  assert.match(sheet, /USD_PRESETS = \[25, 100, 250\]/);
  assert.match(sheet, /mobileTradeCta/);
});

test("percentOf never rounds above the balance", () => {
  for (const balance of [123.4567895, 0.000123456789, 999999.9999999, 1.0000009]) {
    assert.ok(Number(percentOf(balance, 100)) <= balance, `100% of ${balance}`);
  }
});
