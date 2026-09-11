import assert from "node:assert/strict";
import test from "node:test";

import {
  notifyCampaignCreated,
  notifyDraftCreated,
} from "./campaignLifecycleNotifications.js";

function mockDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 1 };
    },
  };
}

function outboxInsert(db) {
  return db.calls.find((call) => String(call.sql).includes("notification_outbox"));
}

test("draft created is chain-agnostic and keyed by draft id", async () => {
  const db = mockDb();
  await notifyDraftCreated(db, {
    chainId: 46630,
    draftId: "draft-1",
    slug: "pepe-rh",
    name: "Pepe",
    ticker: "PEPE",
    creatorWallet: "0xabc",
  });
  const insert = outboxInsert(db);
  const envelope = JSON.parse(insert.params[3]);
  assert.equal(envelope.eventType, "campaign.draft_created");
  assert.equal(envelope.chain, "robinhood");
  assert.equal(envelope.environment, "staging");
  assert.equal(insert.params[2], "campaign-draft-created:robinhood:draft-1");
  assert.equal(envelope.payload.launch.mode, "draft");
});

test("campaign created uses one producer for BNB, Solana, and Robinhood", async () => {
  const cases = [
    { chainId: 56, chain: "bnb", address: "0xAbC", expected: "0xabc" },
    { chainId: 101, chain: "solana", address: "CampAddr111", expected: "CampAddr111" },
    { chainId: 4663, chain: "robinhood", address: "0xDeF", expected: "0xdef" },
  ];
  for (const item of cases) {
    const db = mockDb();
    await notifyCampaignCreated(db, {
      chainId: item.chainId,
      campaignAddress: item.address,
      name: "Token",
      ticker: "TKN",
      creatorWallet: "wallet",
    });
    const insert = outboxInsert(db);
    const envelope = JSON.parse(insert.params[3]);
    assert.equal(envelope.chain, item.chain);
    assert.equal(envelope.eventType, "campaign.created");
    assert.equal(insert.params[2], `campaign-created:${item.chain}:${item.expected}`);
    assert.equal(envelope.payload.launch.mode, "direct");
  }
});

test("scheduled deploy is still campaign.created with launch.mode scheduled", async () => {
  const db = mockDb();
  await notifyCampaignCreated(db, {
    chainId: 97,
    campaignAddress: "0x1",
    scheduledFor: "2026-09-12T00:00:00.000Z",
  });
  const envelope = JSON.parse(outboxInsert(db).params[3]);
  assert.equal(envelope.eventType, "campaign.created");
  assert.equal(envelope.payload.launch.mode, "scheduled");
  assert.equal(envelope.environment, "staging");
});

test("unknown chain does not insert an outbox row", async () => {
  const db = mockDb();
  const ok = await notifyDraftCreated(db, { chainId: 1, draftId: "x" });
  assert.equal(ok, false);
  assert.equal(db.calls.length, 0);
});
