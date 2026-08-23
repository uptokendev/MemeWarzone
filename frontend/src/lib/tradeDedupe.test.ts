import assert from "node:assert/strict";
import test from "node:test";
import { mergeTradePoints, unionIndexedAndLive } from "./tradeDedupe.ts";
import type { CurveTradePoint } from "../hooks/useCurveTrades.ts";

function point(partial: Partial<CurveTradePoint> & { txHash: string }): CurveTradePoint {
  return {
    type: "buy",
    from: "8rEczXrZZMzpp3MAUbs8TWftaZcJxctydwnkHLsdWaRv",
    to: "EFUF3bPBaN3MzSBpm4MfXMdbXDmesPWcKaoNsLzn45VH",
    tokensWei: 1_000_000n,
    nativeWei: 10_000_000n,
    pricePerToken: 0.01,
    timestamp: 1_787_422_385,
    blockNumber: 440978326,
    logIndex: 1,
    ...partial,
  };
}

test("REST snapshot replaces indexed history and does not keep previous indexed rows", () => {
  const previousIndexed = [
    point({ txHash: "HkE3gHdVxbsGw8VsZ2dG235uQcBif1YMtTyrhyzHMxY3y2DAS9EhcCVmWmrWw3WC6pTcwQSSsN4ncwjBBmgZcCg", logIndex: 1 }),
  ];
  const snapshot = [
    point({ txHash: "fSRGHkcP4kQ15kwv3fJBvJyaY5ou8bMQoHx9a1z5ganA6AUNGPQyhnXEHWNosuYbJRJ7S1ZdTSDZ38iqKG49CPv", logIndex: 1 }),
  ];
  const mergedWrong = mergeTradePoints(snapshot, previousIndexed);
  assert.equal(mergedWrong.length, 2);

  const next = unionIndexedAndLive(snapshot, []);
  assert.equal(next.length, 1);
  assert.equal(next[0].txHash, snapshot[0].txHash);
});

test("live unindexed trades remain until the snapshot contains the same tx identity", () => {
  const live = [
    point({
      txHash: "2q4BvTSP3Q1iZ3JLz3tLgq437i1ARgAjxXFRzFGnfQpKpUEhkHyU1PKM1z9kUWDXFaWRuoidFHcCjgJYPVju66mR",
      logIndex: 1,
      timestamp: 1_787_482_856,
    }),
  ];
  const emptyIndexed = unionIndexedAndLive([], live);
  assert.equal(emptyIndexed.length, 1);

  const caughtUp = unionIndexedAndLive(live, live);
  assert.equal(caughtUp.length, 1);
  assert.equal(caughtUp[0].txHash, live[0].txHash);
});
