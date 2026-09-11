import assert from "node:assert/strict";
import test from "node:test";
import { buildNotificationEnvelope, normalizeChain } from "./notificationContract.js";

test("Robinhood is not BNB", () => {
  assert.equal(normalizeChain(4663), "robinhood");
  assert.equal(normalizeChain(46630), "robinhood");
  assert.notEqual(normalizeChain(46630), "bnb");
});

test("envelope resolves staging Robinhood from chainId", () => {
  const envelope = buildNotificationEnvelope({
    eventType: "campaign.progress_threshold_reached",
    chainId: 46630,
    dedupKey: "near-grad-alert:robinhood:camp:95",
    payload: { campaign: "camp", threshold: 95, progressPct: 96.1 },
  });
  assert.equal(envelope.chain, "robinhood");
  assert.equal(envelope.environment, "staging");
  assert.equal(envelope.payload.threshold, 95);
});
