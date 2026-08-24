import assert from "node:assert/strict";
import test from "node:test";
import { mergeIndexerSnapshot, mergeTradePoints, unionIndexedAndLive } from "./tradeDedupe.ts";
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

test("later shorter indexer snapshot must not drop a fill the client already has", () => {
  const first = point({
    txHash: "HkE3gHdVxbsGw8VsZ2dG235uQcBif1YMtTyrhyzHMxY3y2DAS9EhcCVmWmrWw3WC6pTcwQSSsN4ncwjBBmgZcCg",
    logIndex: 1,
    blockNumber: 441223620,
  });
  const second = point({
    txHash: "3oZaXc5EAodXDH6qaZK9Pftds1DjVD8vkizRFU6zJppA272F5hk7xfpZcGpULbZXMySC26C3WdE4tFXiQ939BtXz",
    logIndex: 1,
    blockNumber: 441256954,
  });
  const afterShortPoll = mergeIndexerSnapshot([first, second], [first]);
  assert.equal(afterShortPoll.length, 2);
  const hashes = new Set(afterShortPoll.map((row) => row.txHash));
  assert.equal(hashes.has(first.txHash), true);
  assert.equal(hashes.has(second.txHash), true);
  assert.equal(mergeIndexerSnapshot([first, second], []).length, 2);
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
