import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CHALLENGE_DECLINE_WINDOW_HOURS,
  CHALLENGE_INBOX_EVENTS,
  deriveChallengeInboxEvent,
  isDeclinedChallengeRow,
  loadChallengeInboxRows,
} from "./arenaChallengeInbox.js";
import { CHALLENGE_POPUP_EVENTS, CHALLENGE_INBOX_ONLY_EVENTS } from "../../src/lib/arena/challengePopupPresentation.mjs";

// Two owners: A owns $ALPHA (0xaaa...), B owns $BRAVO (0xbbb...).
const ALPHA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BRAVO = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const A = new Set([ALPHA]);
const B = new Set([BRAVO]);
const NOW = Date.parse("2026-09-25T12:00:00.000Z");

/** The row handleChallenge inserts when A challenges B. */
function challengeRow(over = {}) {
  return {
    id: "fight-1",
    chain_id: 56,
    source: "challenge",
    state: "challenged",
    challenger_token: ALPHA,
    defender_token: BRAVO,
    offer_from_token: ALPHA,
    offer_count: 0,
    decline_message: null,
    created_at: "2026-09-25T11:00:00.000Z",
    updated_at: "2026-09-25T11:00:00.000Z",
    ends_at: "2026-09-26T11:00:00.000Z",
    finished_at: null,
    ...over,
  };
}
// The patches the handlers write, applied to the row, so the flow below is the real sequence.
const counterBy = (row, token) => ({ ...row, offer_from_token: token, offer_count: row.offer_count + 1 });
const accept = (row, state = "matched") => ({ ...row, state });
const decline = (row, message) => ({ ...row, state: "expired", finished_at: "2026-09-25T11:30:00.000Z", decline_message: message ?? "" });
const timeout = (row) => ({ ...row, state: "expired", finished_at: "2026-09-26T11:00:01.000Z" });
const inbox = (row, owner) => deriveChallengeInboxEvent(row, owner, { nowMs: NOW });

test("server event names are the ones the app's popup listens for", () => {
  assert.equal(CHALLENGE_INBOX_EVENTS.received, CHALLENGE_POPUP_EVENTS.received);
  assert.equal(CHALLENGE_INBOX_EVENTS.counter, CHALLENGE_POPUP_EVENTS.counter);
  assert.equal(CHALLENGE_INBOX_EVENTS.accepted, CHALLENGE_POPUP_EVENTS.accepted);
  assert.equal(CHALLENGE_INBOX_EVENTS.declined, CHALLENGE_POPUP_EVENTS.declined);
  assert.equal(CHALLENGE_INBOX_EVENTS.buyInDue, CHALLENGE_INBOX_ONLY_EVENTS.buyInDue);
});

test("A challenges B: B is asked to answer, A waits", () => {
  const row = challengeRow();
  assert.deepEqual(inbox(row, B), { event: "challenge_received", offerCount: 0 });
  assert.equal(inbox(row, A), null);
});

test("B counters: A gets the counter, B waits; A counters back: B gets it", () => {
  const once = counterBy(challengeRow(), BRAVO);
  assert.deepEqual(inbox(once, A), { event: "counter_received", offerCount: 1 });
  assert.equal(inbox(once, B), null);
  const twice = counterBy(once, ALPHA);
  assert.deepEqual(inbox(twice, B), { event: "counter_received", offerCount: 2 });
  assert.equal(inbox(twice, A), null);
});

test("B accepts A's challenge: A is told it was accepted, B owes the buy-in", () => {
  const row = accept(challengeRow());
  assert.deepEqual(inbox(row, A), { event: "challenge_accepted", offerCount: 0 });
  assert.deepEqual(inbox(row, B), { event: "buy_in_due", offerCount: 0 });
});

test("A accepts B's counter: B (who made the accepted offer) is told, A owes the buy-in", () => {
  const row = accept(counterBy(challengeRow(), BRAVO));
  assert.deepEqual(inbox(row, B), { event: "challenge_accepted", offerCount: 1 });
  assert.deepEqual(inbox(row, A), { event: "buy_in_due", offerCount: 1 });
});

test("a funded fight that went live owes nobody a popup from the inbox", () => {
  const row = accept(challengeRow(), "live");
  assert.equal(inbox(row, A), null);
  assert.equal(inbox(row, B), null);
});

test("B declines with a message: A is told, with the message; B is not", () => {
  const row = decline(challengeRow(), "not this week");
  assert.equal(isDeclinedChallengeRow(row), true);
  assert.deepEqual(inbox(row, A), { event: "challenge_declined", offerCount: 0, message: "not this week" });
  assert.equal(inbox(row, B), null);
});

test("a decline without a message still reaches A (stored as empty string, not null)", () => {
  const row = decline(challengeRow(), null);
  assert.equal(row.decline_message, "");
  assert.deepEqual(inbox(row, A), { event: "challenge_declined", offerCount: 0, message: null });
});

test("A declines B's counter: B is told", () => {
  const row = decline(counterBy(challengeRow(), BRAVO), "too rich");
  assert.deepEqual(inbox(row, B), { event: "challenge_declined", offerCount: 1, message: "too rich" });
  assert.equal(inbox(row, A), null);
});

test("a timeout is not a decline, and an old decline has left the inbox", () => {
  assert.equal(inbox(timeout(challengeRow()), A), null);
  assert.equal(isDeclinedChallengeRow(timeout(challengeRow())), false);
  const old = { ...decline(challengeRow(), "x"), finished_at: new Date(NOW - (CHALLENGE_DECLINE_WINDOW_HOURS + 1) * 3600 * 1000).toISOString() };
  assert.equal(inbox(old, A), null);
});

test("strangers, queue battles and self-battles owe nothing; token case does not matter", () => {
  assert.equal(inbox(challengeRow(), new Set(["0xcccccccccccccccccccccccccccccccccccccccc"])), null);
  assert.equal(inbox(challengeRow({ source: "queue" }), B), null);
  assert.equal(inbox(challengeRow(), new Set([ALPHA, BRAVO])), null);
  assert.deepEqual(inbox(challengeRow({ defender_token: BRAVO.toUpperCase().replace("0X", "0x") }), B), { event: "challenge_received", offerCount: 0 });
});

test("Solana: base58 tokens compare the same way the SQL does", () => {
  const sa = "So11111111111111111111111111111111111111112";
  const sb = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const row = challengeRow({ chain_id: 101, challenger_token: sa, defender_token: sb, offer_from_token: sa });
  assert.deepEqual(inbox(row, new Set([sb.toLowerCase()])), { event: "challenge_received", offerCount: 0 });
});

test("the handlers write what the inbox reads", async () => {
  const source = await readFile(new URL("../arenaBattles.js", import.meta.url), "utf8");
  assert.match(source, /decline_message: message \?\? ""/, "decline must store \"\" when no message, or a silent decline reads as a timeout");
  assert.match(source, /path === "\/arena\/battles\/inbox"\) return handleInbox/);
  assert.match(source, /Date\.parse\(row\.ends_at \|\| 0\)/, "expiry follows ends_at, which a counter restarts");
});

// The SQL against a real Postgres (staging), inside a transaction that is rolled back.
const STAGING = process.env.STAGING_DATABASE_URL || "";
test("inbox SQL returns open, matched and recently-declined challenges for the owner's tokens", { skip: !STAGING && "STAGING_DATABASE_URL not set" }, async () => {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: STAGING, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const cols = "id, chain_id, state, source, challenger_token, defender_token, offer_from_token, offer_count, decline_message, created_at, updated_at, ends_at, finished_at";
  const tag = `inbox-test-${Date.now()}`;
  const insert = (id, state, extra = {}) => client.query(
    `insert into public.arena_battles (id, chain_id, state, source, format, participants, challenger_token, defender_token, offer_from_token, offer_count, decline_message, finished_at, ends_at, created_at, updated_at)
     values ($1, 56, $2, $3, 'duel', '[]'::jsonb, $4, $5, $6, $7, $8, $9, now() + interval '1 day', now(), now())`,
    [id, state, extra.source || "challenge", ALPHA, BRAVO, extra.from || ALPHA, extra.count || 0, extra.decline ?? null, extra.finished ?? null],
  );
  try {
    await client.query("begin");
    // Staging may predate db/migrations/20260924_000001 (production has it). DDL is transactional,
    // so this is rolled back with everything else.
    await client.query("alter table public.arena_battles add column if not exists decline_message text");
    await insert(`${tag}-open`, "challenged");
    await insert(`${tag}-matched`, "matched");
    await insert(`${tag}-declined`, "expired", { decline: "", finished: new Date().toISOString() });
    await insert(`${tag}-timeout`, "expired", { finished: new Date().toISOString() });
    await insert(`${tag}-old-decline`, "expired", { decline: "x", finished: new Date(Date.now() - 80 * 3600 * 1000).toISOString() });
    await insert(`${tag}-queue`, "challenged", { source: "queue" });
    const rows = await loadChallengeInboxRows(client, { chainId: 56, ownedKeys: [BRAVO.toUpperCase().replace("0X", "0x")], columns: cols });
    const ids = rows.map((r) => r.id).filter((id) => id.startsWith(tag)).sort();
    assert.deepEqual(ids, [`${tag}-declined`, `${tag}-matched`, `${tag}-open`]);
    const events = Object.fromEntries(rows.filter((r) => r.id.startsWith(tag)).map((r) => [r.id.slice(tag.length + 1), deriveChallengeInboxEvent(r, A)?.event ?? null]));
    assert.deepEqual(events, { open: null, matched: "challenge_accepted", declined: "challenge_declined" });
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
});
