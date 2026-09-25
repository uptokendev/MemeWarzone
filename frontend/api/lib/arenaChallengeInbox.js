/**
 * A creator's challenge inbox, derived from arena_battles alone.
 *
 * The realtime event (Ably, arena:creator:{chain}:{wallet}) is instant but best-effort: it is
 * lost when the owner is offline, the tab is closed, or the socket is down. This is the other
 * half, and the one that makes delivery certain: every popup the realtime path can show is
 * re-derived here from the battle row, so a page load, a return to the tab or a periodic poll
 * shows the same popup the socket would have.
 *
 *   challenged, the other side made the live offer -> challenge_received (offer 0) / counter_received
 *   matched, I made the offer that was accepted      -> challenge_accepted (pay your buy-in)
 *   matched, I accepted                               -> buy_in_due
 *   expired by a decline, I made the declined offer   -> challenge_declined (with the message)
 *
 * A decline is told apart from a timeout by decline_message being non-null: the decline route
 * stores "" when no message was given, and expiry never writes the column.
 */

export const CHALLENGE_INBOX_EVENTS = Object.freeze({
  received: "challenge_received",
  counter: "counter_received",
  accepted: "challenge_accepted",
  declined: "challenge_declined",
  buyInDue: "buy_in_due",
});

/** How long a decline stays in the inbox for an owner who has not been back. */
export const CHALLENGE_DECLINE_WINDOW_HOURS = 72;
export const CHALLENGE_INBOX_LIMIT = 50;

function key(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function ownedKeySet(values) {
  const out = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const k = key(value);
    if (k) out.add(k);
  }
  return out;
}

export function isDeclinedChallengeRow(row) {
  return String(row?.state || "") === "expired" && row?.decline_message !== null && row?.decline_message !== undefined;
}

/**
 * Pure: which popups a row owes the owner of `owned`, if any. Rows are arena_battles rows
 * (snake_case), already hydrated so an overdue challenge reads as expired.
 */
export function deriveChallengeInboxEvent(row, owned, { nowMs = Date.now() } = {}) {
  if (!row || String(row.source || "") !== "challenge") return null;
  const keys = owned instanceof Set ? owned : ownedKeySet(owned);
  if (!keys.size) return null;
  const challenger = key(row.challenger_token);
  const defender = key(row.defender_token);
  if (!keys.has(challenger) && !keys.has(defender)) return null;
  // Owning both sides is not a battle anyone needs to be told about.
  if (keys.has(challenger) && keys.has(defender)) return null;
  const offerer = key(row.offer_from_token) || challenger;
  const iOffered = keys.has(offerer);
  const offerCount = Math.max(0, Number(row.offer_count || 0));
  const state = String(row.state || "");

  if (state === "challenged") {
    if (iOffered) return null; // waiting on the other owner
    return { event: offerCount > 0 ? CHALLENGE_INBOX_EVENTS.counter : CHALLENGE_INBOX_EVENTS.received, offerCount };
  }
  if (state === "matched") {
    return { event: iOffered ? CHALLENGE_INBOX_EVENTS.accepted : CHALLENGE_INBOX_EVENTS.buyInDue, offerCount };
  }
  if (isDeclinedChallengeRow(row)) {
    if (!iOffered) return null; // the decliner does not need telling
    const at = Date.parse(row.finished_at || row.updated_at || 0);
    if (!Number.isFinite(at) || nowMs - at > CHALLENGE_DECLINE_WINDOW_HOURS * 3600 * 1000) return null;
    const message = String(row.decline_message || "").trim();
    return { event: CHALLENGE_INBOX_EVENTS.declined, offerCount, message: message || null };
  }
  return null;
}

/**
 * The rows that can owe a popup: open challenges and matched fights for these tokens, plus
 * recent declines. `db` is anything with pg's query(text, params).
 */
export async function loadChallengeInboxRows(db, { chainId, ownedKeys, columns, limit = CHALLENGE_INBOX_LIMIT }) {
  const keys = [...ownedKeySet(ownedKeys)];
  if (!keys.length) return [];
  const result = await db.query(
    `select ${columns}
       from public.arena_battles
      where chain_id = $1
        and source = 'challenge'
        and (lower(coalesce(challenger_token, '')) = any($2::text[]) or lower(coalesce(defender_token, '')) = any($2::text[]))
        and (
          state in ('challenged', 'matched')
          or (state = 'expired' and decline_message is not null
              and coalesce(finished_at, updated_at) > now() - make_interval(hours => $3))
        )
      order by coalesce(updated_at, created_at) desc
      limit $4`,
    [Number(chainId), keys, CHALLENGE_DECLINE_WINDOW_HOURS, Math.max(1, Math.min(200, Number(limit) || CHALLENGE_INBOX_LIMIT))],
  );
  return result.rows;
}
