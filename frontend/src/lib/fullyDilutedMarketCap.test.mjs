import assert from "node:assert/strict";
import test from "node:test";
import { evmCurveSpotChanges, evmCurveSpotWei, fullyDilutedSupplyWhole } from "./fullyDilutedMarketCap.mjs";

const E18 = 10n ** 18n;
const WINDOWS = { "5m": 300, "1h": 3600, "4h": 14400, "24h": 86400 };
const t = (iso) => Math.floor(Date.parse(iso) / 1000);

test("total supply in whole tokens (gen-6 tokens mint 1,000,000,000)", () => {
  assert.equal(fullyDilutedSupplyWhole(10n ** 27n, 18), 1_000_000_000);
  assert.equal(fullyDilutedSupplyWhole(0n), null);
  assert.equal(fullyDilutedSupplyWhole(null), null);
  assert.equal(fullyDilutedSupplyWhole("not a number"), null);
});

test("curve spot is LaunchCampaign._currentPrice (Robinhood 0x404d723d read on chain 2026-10-01)", () => {
  // basePrice 1e9, priceSlope 850, sold 681160.182212507758066507 -> currentPrice 1578986154
  assert.equal(evmCurveSpotWei(1_000_000_000n, 850n, 681160182212507758066507n), 1_578_986_154n);
  assert.equal(evmCurveSpotWei(1_000_000_000n, 850n, 0n), 1_000_000_000n);
});

test("BNB 0x49ac80f9: buy then full sell is 0% on every window, not the fills' -3.92%", () => {
  const changes = evmCurveSpotChanges({
    trades: [
      { timestamp: t("2026-10-01T17:27:00Z"), type: "buy", tokensWei: 3434435198175476000000000n },
      { timestamp: t("2026-10-01T17:28:15Z"), type: "sell", tokensWei: 3434435198175476000000000n },
    ],
    soldNowRaw: 0n, basePriceWei: 1_000_000_000n, priceSlopeWei: 1080n,
    nowSec: t("2026-10-01T18:00:00Z"), windows: WINDOWS,
  });
  assert.deepEqual(changes, { "5m": 0, "1h": 0, "4h": 0, "24h": 0 });
});

test("Robinhood 0x404d723d: +57.9% since the start price; 0% over the last 5 minutes", () => {
  const trades = [
    { timestamp: t("2026-10-01T17:40:02Z"), type: "buy", tokensWei: 744697837477004000000000n },
    { timestamp: t("2026-10-01T17:45:04Z"), type: "sell", tokensWei: 63537655264496240000000n },
  ];
  const changes = evmCurveSpotChanges({
    trades, soldNowRaw: 681160182212507758066507n, basePriceWei: 1_000_000_000n, priceSlopeWei: 850n,
    nowSec: t("2026-10-01T18:00:00Z"), windows: WINDOWS,
  });
  assert.equal(changes["5m"], 0);
  assert.ok(Math.abs(changes["1h"] - 57.8986154) < 1e-6);
  assert.equal(changes["24h"], changes["1h"]);
  // Inside the window that holds only the sell, the change is spot after the buy -> spot now.
  const mid = evmCurveSpotChanges({
    trades, soldNowRaw: 681160182212507758066507n, basePriceWei: 1_000_000_000n, priceSlopeWei: 850n,
    nowSec: t("2026-10-01T17:47:00Z"), windows: { "5m": 300 },
  });
  const afterBuy = Number(evmCurveSpotWei(1_000_000_000n, 850n, 744697837477004000000000n));
  assert.ok(Math.abs(mid["5m"] - ((1_578_986_154 - afterBuy) / afterBuy) * 100) < 1e-9);
  assert.ok(mid["5m"] < 0);
});

test("a trade list that starts mid-history still gives exact spots (sold anchored at today's value)", () => {
  const changes = evmCurveSpotChanges({
    trades: [{ timestamp: 2_000, type: "buy", tokensWei: 1_000n * E18 }],
    soldNowRaw: 5_000n * E18, basePriceWei: 1_000n, priceSlopeWei: 1n,
    nowSec: 2_100, windows: { "5m": 300 },
  });
  // spot before = 1000 + 4000 = 5000, after = 6000 -> +20%
  assert.ok(Math.abs(changes["5m"] - 20) < 1e-9);
  assert.deepEqual(evmCurveSpotChanges({ trades: [], soldNowRaw: 0n, basePriceWei: 0n, priceSlopeWei: 0n, nowSec: 1, windows: { "5m": 300 } }), { "5m": null });
});
