import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMarketConsistency,
  canonicalAthUsd,
  canonicalMcapUsd,
  marketValuesAgree,
  volumeNativeFromTrades,
} from "./canonicalMarket.ts";

test("canonical mcap is spot × sold × usd", () => {
  assert.equal(canonicalMcapUsd(0.001, 1290, 1), 1.29);
  assert.equal(canonicalMcapUsd(0, 1000, 1), 0);
});

test("ATH is max of current, indexed, and series", () => {
  assert.equal(canonicalAthUsd(1.29, 4.75, 4.77), 4.77);
  assert.equal(canonicalAthUsd(5.45, 5.45, 7.24), 7.24);
});

test("chart close and header mcap must agree", () => {
  const failures = assertMarketConsistency({
    headerMcapUsd: 1.29,
    wtrMcapUsd: 1.29,
    chartLatestMcapUsd: 4.77,
    chartAthUsd: 4.75,
    canonicalAthUsd: 4.75,
    tokenDetailsVol24hUsd: 1.88,
    wtrVol24hUsd: 1.88,
    tokenDetailsHolders: 1,
    wtrHolders: 1,
  });
  assert.ok(failures.some((row) => row.includes("chartLatest")));
  assert.equal(
    assertMarketConsistency({
      headerMcapUsd: 5.45,
      wtrMcapUsd: 5.45,
      chartLatestMcapUsd: 5.45,
      chartAthUsd: 5.45,
      canonicalAthUsd: 5.45,
      tokenDetailsVol24hUsd: 0,
      wtrVol24hUsd: 0,
      tokenDetailsHolders: 0,
      wtrHolders: 0,
    }).length,
    0,
  );
});

test("24h volume ignores older prints", () => {
  const now = 1_000_000;
  const native = volumeNativeFromTrades(
    [
      { nativeWei: 2_000_000_000n, timestamp: now - 100 },
      { nativeWei: 9_000_000_000n, timestamp: now - 200_000 },
    ],
    9,
    now,
  );
  assert.equal(native, 2);
});

test("marketValuesAgree allows display rounding", () => {
  assert.equal(marketValuesAgree(1.29, 1.291), true);
  assert.equal(marketValuesAgree(1.29, 4.77), false);
});
