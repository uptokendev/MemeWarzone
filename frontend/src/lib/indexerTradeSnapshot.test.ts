import assert from "node:assert/strict";
import test from "node:test";
import { parseIndexerTradeBody, shouldRunSolanaHistoryFallback, shouldRunSolanaTipReconcile } from "./indexerTradeSnapshot.ts";

test("legacy array response is not treated as Solana durable-complete", () => {
  const parsed = parseIndexerTradeBody([{ tx_hash: "sig" }], 101);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.historyComplete, null);
  assert.equal(shouldRunSolanaHistoryFallback({
    fallbackEnabled: true,
    indexerOk: true,
    historyComplete: parsed.historyComplete,
    indexerRows: parsed.items.length,
  }), false);
});

test("empty incomplete indexer book still uses on-chain fallback", () => {
  assert.equal(shouldRunSolanaHistoryFallback({
    fallbackEnabled: true,
    indexerOk: true,
    historyComplete: false,
    indexerRows: 0,
  }), true);
});

test("historyComplete=true skips on-chain fallback", () => {
  const parsed = parseIndexerTradeBody({
    items: [{ tx_hash: "a" }, { tx_hash: "b" }],
    historyComplete: true,
    repairState: "complete",
    campaignAddress: "EFUF3bPBaN3MzSBpm4MfXMdbXDmesPWcKaoNsLzn45VH",
  }, 101);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.historyComplete, true);
  assert.equal(parsed.lastIndexedSlot, null);
  assert.equal(shouldRunSolanaHistoryFallback({
    fallbackEnabled: true,
    indexerOk: true,
    historyComplete: true,
  }), false);
});

test("Solana envelope lastIndexedSlot is parsed for tip reconcile", () => {
  const parsed = parseIndexerTradeBody({
    items: [{ tx_hash: "heWs9aJGiKrEgDhQ1pLhabmV7pehtTiz7pP3ZqopaEVxYTCVtpEGpd1pFvr56bjxXCuMBnvocznKwexR4DJqHqP" }],
    historyComplete: true,
    lastIndexedSlot: 441223620,
    campaignAddress: "9t72mNAVpnJCn42Z2quJTqoS8wsBTGR9aG2CvbeumXEF",
  }, 101);
  assert.equal(parsed.lastIndexedSlot, 441223620);
});

test("indexer failure still invokes fallback when enabled", () => {
  assert.equal(shouldRunSolanaHistoryFallback({
    fallbackEnabled: true,
    indexerOk: false,
    historyComplete: true,
  }), true);
});

test("a non-empty complete book still runs bounded PDA tip reconcile", () => {
  assert.equal(shouldRunSolanaTipReconcile({
    fallbackEnabled: true,
    indexerOk: true,
    indexerRows: 1,
  }), true);
  assert.equal(shouldRunSolanaHistoryFallback({
    fallbackEnabled: true,
    indexerOk: true,
    historyComplete: true,
    indexerRows: 1,
  }), false);
});

test("disabled fallback never runs", () => {
  assert.equal(shouldRunSolanaHistoryFallback({
    fallbackEnabled: false,
    indexerOk: false,
    historyComplete: false,
  }), false);
});
