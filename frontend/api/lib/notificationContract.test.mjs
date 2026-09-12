import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNotificationEnvelope,
  enqueueNotification,
  getChainById,
  normalizeChain,
  resolveChainEnvironment,
} from "./notificationContract.js";

test("Robinhood ids are not BNB", () => {
  assert.equal(normalizeChain(4663), "robinhood");
  assert.equal(normalizeChain(46630), "robinhood");
  assert.equal(getChainById(56), "bnb");
  assert.equal(getChainById(101), "solana");
  assert.equal(getChainById(102), "solana");
  assert.equal(normalizeChain(1), null);
});

test("not-Solana is not silently BNB", () => {
  assert.notEqual(normalizeChain(4663), "bnb");
  assert.notEqual(normalizeChain(46630), normalizeChain(97));
});

test("environment follows chain id", () => {
  assert.equal(resolveChainEnvironment({ chainId: 46630 }), "staging");
  assert.equal(resolveChainEnvironment({ chainId: 4663 }), "production");
  assert.equal(resolveChainEnvironment({ chainId: 97 }), "staging");
  assert.equal(resolveChainEnvironment({ chainId: 101 }), "production");
});

test("buildNotificationEnvelope wraps V1 and keeps inner payload", () => {
  const envelope = buildNotificationEnvelope({
    eventType: "campaign.created",
    chainId: 46630,
    entityType: "campaign",
    entityId: "0xabc",
    dedupKey: "campaign-created:robinhood:0xabc",
    payload: { campaign: "0xabc", name: "RHMEME" },
  });
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.chain, "robinhood");
  assert.equal(envelope.environment, "staging");
  assert.equal(envelope.payload.name, "RHMEME");
  assert.equal(envelope.payload.campaign, "0xabc");
});

test("legacy chain label still works when chainId is absent", () => {
  const envelope = buildNotificationEnvelope({
    eventType: "campaign.graduated",
    chain: "solana",
    dedupKey: "graduation:solana:camp",
    payload: { campaign: "camp" },
  });
  assert.equal(envelope.chain, "solana");
  assert.equal(envelope.entityId, "camp");
});

test("unknown chain throws instead of falling back to BNB", () => {
  assert.throws(
    () => buildNotificationEnvelope({
      eventType: "campaign.created",
      chain: "ethereum",
      dedupKey: "x",
      payload: {},
    }),
    /UNSUPPORTED_CHAIN/,
  );
});

test("enqueueNotification inserts wrapped envelope and honors marker skip", async () => {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("notification_markers")) return { rowCount: 1 };
      return { rowCount: 1 };
    },
  };
  const ok = await enqueueNotification(db, {
    eventType: "campaign.created",
    chainId: 56,
    dedupKey: "campaign-created:bnb:camp1",
    payload: { campaign: "camp1" },
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  const inserted = JSON.parse(calls[0].params[3]);
  assert.equal(inserted.schemaVersion, 1);
  assert.equal(inserted.chain, "bnb");
  assert.equal(calls[0].params[1], "bnb");
});

test("enqueueNotification skips when marker already exists", async () => {
  const db = {
    query: async (sql) => {
      if (sql.includes("notification_markers")) return { rowCount: 0 };
      throw new Error("should not insert outbox");
    },
  };
  const ok = await enqueueNotification(db, {
    eventType: "campaign.progress_threshold_reached",
    chain: "bnb",
    dedupKey: "near-grad:bnb:c:95",
    markerKey: "near-grad:bnb:c:95",
    payload: { campaign: "c", threshold: 95 },
  });
  assert.equal(ok, false);
});
