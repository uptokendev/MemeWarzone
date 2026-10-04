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

test("buy MAX / % and the check before signing keep fees and gas back", () => {
  const sheet = fs.readFileSync(new URL("../components/token/MobileTradeSheet.tsx", import.meta.url), "utf8");
  const page = fs.readFileSync(new URL("../pages/TokenDetails.tsx", import.meta.url), "utf8");
  const warRoom = fs.readFileSync(new URL("../components/postgrad/WarRoomTradePanel.tsx", import.meta.url), "utf8");
  const rhWarRoom = fs.readFileSync(new URL("../components/postgrad/RobinhoodWarRoomTradePanel.tsx", import.meta.url), "utf8");
  const trade = fs.readFileSync(new URL("./solanaTradeV1.ts", import.meta.url), "utf8");
  const reserve = fs.readFileSync(new URL("./tradeBalanceReserve.ts", import.meta.url), "utf8");
  assert.match(reserve, /SOLANA_BUY_FEE_RESERVE_LAMPORTS = 5_000_000n/);
  assert.match(reserve, /SOLANA_BUY_FEE_RESERVE_SOL = 0\.005/);
  assert.match(reserve, /BNB_BUY_GAS_RESERVE_WEI = 500_000_000_000_000n/);
  assert.match(reserve, /ETH_BUY_GAS_RESERVE_WEI = 200_000_000_000_000n/);
  // MAX / %
  assert.match(sheet, /percentOf\(Math\.max\(0, nativeBalance - reserve\), pct\)/);
  assert.match(page, /if \(isSolanaPage\) return solanaQuote\.native \? SOLANA_BUY_FEE_RESERVE_SOL : 0;/);
  assert.match(page, /return gas \+ \(afterGas \* SLIPPAGE_PCT\) \/ \(100 \+ SLIPPAGE_PCT\);/);
  assert.match(warRoom, /isSolanaCampaign \? SOLANA_BUY_FEE_RESERVE_LAMPORTS : evmBuyGasReserveWei\(false\)/);
  // Typed amounts: checked before signing
  assert.match(page, /solanaQuote\.native && bnbBalanceWei != null && amountIn \+ SOLANA_BUY_FEE_RESERVE_LAMPORTS > bnbBalanceWei/);
  assert.match(page, /maxCostWei \+ gasReserveWei > bnbBalanceWei/);
  assert.match(page, /nativeAmountInRaw \+ topazGasReserve > bnbBalanceWei/);
  assert.match(warRoom, /nativeAmountInRaw \+ gasReserveWei > bnbBalanceWei/);
  assert.match(rhWarRoom, /amountIn \+ ETH_BUY_GAS_RESERVE_WEI > nativeBalance/);
  // Raw simulation text for System Program error 1 is replaced with a plain message.
  assert.match(trade, /insufficient lamports\|Program 1\{32\} failed: custom program error: 0x1/);
  // 100% of 0.128754 SOL with the reserve leaves 0.005 SOL in the wallet.
  assert.equal(percentOf(0.128754 - 0.005, 100), "0.123754");
});
