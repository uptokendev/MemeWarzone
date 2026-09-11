import assert from "node:assert/strict";
import test from "node:test";
import {
  notifyBattleCreated,
  notifyBattleWinnerConfirmed,
  tournamentNotificationForTransition,
} from "./arenaLifecycleNotifications.js";

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

function outbox(db) {
  return db.calls.find((call) => String(call.sql).includes("notification_outbox"));
}

test("battle.created is keyed by battle id and keeps chainId", async () => {
  const db = mockDb();
  await notifyBattleCreated(db, {
    id: "b1",
    chain_id: 46630,
    challenger_token: "0xleft",
    defender_token: "0xright",
    source: "manual",
  });
  const envelope = JSON.parse(outbox(db).params[3]);
  assert.equal(envelope.eventType, "battle.created");
  assert.equal(envelope.chain, "robinhood");
  assert.equal(outbox(db).params[2], "battle-created:b1");
  assert.equal(envelope.payload.left.campaignId, "0xleft");
});

test("battle winner uses settlement version in the dedup key", async () => {
  const db = mockDb();
  await notifyBattleWinnerConfirmed(db, {
    id: "b1",
    chain_id: 56,
    winner_token: "0xleft",
    challenger_token: "0xleft",
    defender_token: "0xright",
    settlement_version: 3,
  });
  assert.equal(outbox(db).params[2], "battle-winner:b1:3");
});

test("tournament transitions map to public Discord events", () => {
  assert.equal(
    tournamentNotificationForTransition({ registration_state: "closed" }, { registration_state: "open", status: "published" }),
    "tournament.registration_open",
  );
  assert.equal(
    tournamentNotificationForTransition({ status: "published" }, { status: "live" }),
    "tournament.started",
  );
  assert.equal(
    tournamentNotificationForTransition({ status: "live" }, { status: "complete" }),
    "tournament.winners_confirmed",
  );
});
