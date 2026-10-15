import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOST_MAX_UNITS_PER_WALLET,
  BOOST_MIN_QUOTE_SECONDS,
  EVM_RESERVATION_SETTLE_GRACE_MS,
  boostRulesShape,
  boostWindowCloseMs,
  boostWindowClosed,
  boostWindowOpen,
  clampedQuoteDeadlineSeconds,
  evmWalletBoostUnitsUsed,
  solanaWalletBoostUnitsUsed,
  walletBoostCapExceeded,
} from "./arenaBoostRules.js";
import { VOTE_BATTLE_BOOST_POINTS_PER_UNIT } from "./arenaBattleMode.js";

const START = Date.parse("2026-10-15T00:00:00Z");
const HOUR = 3_600_000;
const battle24h = { started_at: new Date(START).toISOString(), ends_at: new Date(START + 24 * HOUR).toISOString(), duration_hours: 24 };

test("founder rules: 2 Boosts per wallet, 1 point per vote Boost, close at 80%", () => {
  assert.equal(BOOST_MAX_UNITS_PER_WALLET, 2);
  assert.equal(VOTE_BATTLE_BOOST_POINTS_PER_UNIT, 1);
  // 24 h battle: Boosts close 19 h 12 min after the start.
  assert.equal(boostWindowCloseMs(battle24h), START + 19.2 * HOUR);
});

test("Boost window is open until 80% of the clock and closed after", () => {
  const close = START + 19.2 * HOUR;
  assert.equal(boostWindowOpen(battle24h, close - 1), true);
  assert.equal(boostWindowOpen(battle24h, close), false);
  assert.equal(boostWindowClosed(battle24h, close - 1), null);
  const closed = boostWindowClosed(battle24h, close);
  assert.equal(closed.status, 409);
  assert.equal(closed.code, "BOOST_WINDOW_CLOSED");
  assert.equal(closed.boostClosesAt, new Date(close).toISOString());
  assert.deepEqual(boostRulesShape(battle24h, close - 1), { maxUnitsPerWallet: 2, windowFraction: 0.8, closesAt: new Date(close).toISOString(), open: true });
});

test("Boost window falls back to duration_hours and refuses an unknown clock", () => {
  const noStart = { ends_at: battle24h.ends_at, duration_hours: 6 };
  assert.equal(boostWindowCloseMs(noStart), START + 24 * HOUR - 6 * HOUR + 0.8 * 6 * HOUR);
  assert.equal(boostWindowCloseMs({ ends_at: battle24h.ends_at }), null);
  assert.equal(boostWindowCloseMs({ started_at: battle24h.started_at }), null);
  assert.equal(boostWindowOpen({ ends_at: battle24h.ends_at }, START), false);
});

test("wallet cap counts both sides and names what is left", () => {
  assert.equal(walletBoostCapExceeded(0n, 2n), null);
  assert.equal(walletBoostCapExceeded(1n, 1n), null);
  const over = walletBoostCapExceeded(1n, 2n);
  assert.equal(over.code, "BOOST_WALLET_LIMIT");
  assert.match(over.error, /can buy 1 more Boost in this battle/);
  assert.match(walletBoostCapExceeded(2n, 1n).error, /already used its 2 Boosts/);
  assert.match(walletBoostCapExceeded(0n, 3n).error, /can buy 2 more Boosts/);
});

test("quote deadline never passes the Boost close and needs time to pay", () => {
  const closeSec = Math.floor((START + 19.2 * HOUR) / 1000);
  assert.equal(clampedQuoteDeadlineSeconds(battle24h, closeSec - 3600, 300), closeSec - 3300);
  assert.equal(clampedQuoteDeadlineSeconds(battle24h, closeSec - 100, 300), closeSec);
  assert.equal(clampedQuoteDeadlineSeconds(battle24h, closeSec - BOOST_MIN_QUOTE_SECONDS, 300), closeSec);
  assert.equal(clampedQuoteDeadlineSeconds(battle24h, closeSec - BOOST_MIN_QUOTE_SECONDS + 1, 300), null);
});

function fakeDb(handlers) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      for (const [pattern, reply] of handlers) if (pattern.test(text)) return typeof reply === "function" ? reply(text, params) : reply;
      return { rows: [] };
    },
  };
}

test("Solana count = confirmed actions + quotes that can still land", async () => {
  const db = fakeDb([
    [/from public\.arena_contest_actions/, { rows: [{ units: "1" }] }],
    [/from public\.arena_solana_boost_quotes/, { rows: [{ units: "1" }] }],
  ]);
  assert.equal(await solanaWalletBoostUnitsUsed(db, { chainId: 101, battleId: "b1", wallet: "W" }), 2n);
  assert.match(db.calls[1].text, /payment_status in \('pending','submitted','confirming','recovering','verifying'\)/);
  assert.match(db.calls[1].text, /signature_reference is not null or expires_at > now\(\)/);
});

test("EVM count: open and paid reservations count, expired ones resolve from usedBoostNonces", async () => {
  const now = Date.parse("2026-10-15T10:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  const rows = [
    { id: 1, treasury_address: "0xt", nonce: "11", boost_units: "1", deadline: iso(now - 600_000), status: "paid" },
    { id: 2, treasury_address: "0xt", nonce: "12", boost_units: "1", deadline: iso(now + 60_000), status: "pending" },
    { id: 3, treasury_address: "0xt", nonce: "13", boost_units: "1", deadline: iso(now - EVM_RESERVATION_SETTLE_GRACE_MS + 1_000), status: "pending" },
    { id: 4, treasury_address: "0xt", nonce: "14", boost_units: "2", deadline: iso(now - EVM_RESERVATION_SETTLE_GRACE_MS - 1_000), status: "pending" },
    { id: 5, treasury_address: "0xt", nonce: "15", boost_units: "1", deadline: iso(now - EVM_RESERVATION_SETTLE_GRACE_MS - 1_000), status: "pending" },
  ];
  const updates = [];
  const db = fakeDb([
    [/from public\.arena_boost_quote_reservations/, { rows }],
    [/update public\.arena_boost_quote_reservations/, (_t, params) => { updates.push(params); return { rows: [] }; }],
  ]);
  const reads = [];
  const used = await evmWalletBoostUnitsUsed(db, {
    chainId: 56, battleId: "b1", wallet: "0xw", nowMs: now,
    readNonceUsed: async ({ nonce }) => { reads.push(nonce); return nonce === "15"; },
  });
  // 1 paid + 1 open + 1 inside grace + nonce 15 paid on chain; nonce 14 never paid -> void.
  assert.equal(used, 4n);
  assert.deepEqual(reads, ["14", "15"]);
  assert.deepEqual(updates, [[4, "void"], [5, "paid"]]);
});

test("EVM count fails closed when the chain read fails", async () => {
  const now = Date.parse("2026-10-15T10:00:00Z");
  const db = fakeDb([
    [/from public\.arena_boost_quote_reservations/, { rows: [{ id: 9, treasury_address: "0xt", nonce: "9", boost_units: "2", deadline: new Date(now - 3_600_000).toISOString(), status: "pending" }] }],
  ]);
  const used = await evmWalletBoostUnitsUsed(db, { chainId: 56, battleId: "b1", wallet: "0xw", nowMs: now, readNonceUsed: async () => { throw new Error("rpc down"); } });
  assert.equal(used, 2n);
  assert.equal(db.calls.filter((c) => /update/.test(c.text)).length, 0);
});
