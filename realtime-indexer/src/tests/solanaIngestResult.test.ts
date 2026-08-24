import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignHistoryComplete,
  persistDecodedAnchorEvents,
  shouldMarkPdaSignatureProcessed,
} from "../solanaIngestResult.js";

test("TokensBought decode + insertTrade throw is not marked processed and keeps history incomplete", async () => {
  const persisted: string[] = [];
  const result = {
    fetched: true,
    ...(await persistDecodedAnchorEvents({
      events: [{ kind: "FeeSlicesAccrued" }, { kind: "TokensBought" }],
      persistEvent: async (event) => {
        if (event.kind === "TokensBought") throw new Error("insertTrade failed");
        persisted.push(event.kind);
      },
    })),
  };
  assert.equal(result.tradeEvents, 1);
  assert.equal(result.persistedTradeEvents, 0);
  assert.equal(result.failedEvents, 1);
  assert.equal(result.retryableFailure, true);
  assert.equal(shouldMarkPdaSignatureProcessed(result), false);
  assert.deepEqual(persisted, ["FeeSlicesAccrued"]);
  assert.equal(
    campaignHistoryComplete({
      reachedCreationSlot: true,
      ingestCapped: false,
      retryableFailures: 1,
      unprocessedInWindow: 1,
    }),
    false,
  );
});

test("vote/non-trade signature with no BUY/SELL is safely marked processed", async () => {
  const result = {
    fetched: true,
    ...(await persistDecodedAnchorEvents({
      events: [{ kind: "FeeSlicesAccrued" }],
      persistEvent: async () => undefined,
    })),
  };
  assert.equal(result.tradeEvents, 0);
  assert.equal(result.persistedTradeEvents, 0);
  assert.equal(result.retryableFailure, false);
  assert.equal(shouldMarkPdaSignatureProcessed(result), true);
  assert.equal(
    campaignHistoryComplete({
      reachedCreationSlot: true,
      ingestCapped: false,
      retryableFailures: 0,
      unprocessedInWindow: 0,
    }),
    true,
  );
});

test("empty decode after a successful fetch is processed and not retried forever", async () => {
  const result = {
    fetched: true,
    ...(await persistDecodedAnchorEvents({
      events: [],
      persistEvent: async () => {
        throw new Error("must not run");
      },
    })),
  };
  assert.equal(result.decodedEvents, 0);
  assert.equal(result.retryableFailure, false);
  assert.equal(shouldMarkPdaSignatureProcessed(result), true);
});
