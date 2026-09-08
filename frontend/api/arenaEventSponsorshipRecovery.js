import { pool } from "../server/db.js";
import { json, readJson } from "../server/http.js";
import arenaSponsorships from "./arenaSponsorships.js";
import arenaSponsorshipPublic from "./arenaSponsorshipPublic.js";
import { resolveEventFromQuote, resolveSponsorableEvent } from "./lib/eventSponsorshipAuthority.mjs";

function pathOf(req) { return String(req.path || new URL(req.url, "http://localhost").pathname); }
function ident(value) { return String(value || "").trim(); }

async function reconcileFoundingSponsor(eventId) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`event-sponsorship-founder:${eventId}`]);
    const winner = (await client.query(
      `select es.event_id,es.id as event_sponsorship_id,es.sponsor_profile_id,q.sponsor_wallet,p.id as payment_id,p.confirmed_at,p.signature_reference
         from public.sponsorship_payments p
         join public.event_sponsorships es on es.id=p.event_sponsorship_id
         join public.sponsorship_payment_quotes q on q.id=p.quote_id
        where es.event_id=$1 and p.status='confirmed'
        order by p.confirmed_at asc,p.signature_reference asc,p.id asc limit 1`,
      [eventId],
    )).rows[0];
    if (!winner) { await client.query("commit"); return null; }
    const previous = (await client.query(`select * from public.event_sponsorship_founding_history where event_id=$1 order by id desc limit 1`, [eventId])).rows[0];
    if (previous?.payment_id === winner.payment_id) { await client.query("commit"); return winner; }
    await client.query(
      `insert into public.event_sponsorship_founding_history(event_id,event_sponsorship_id,payment_id,sponsor_profile_id,sponsor_wallet,confirmed_at,payment_identity,supersedes_history_id)
       values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(event_id,payment_id) do nothing`,
      [winner.event_id,winner.event_sponsorship_id,winner.payment_id,winner.sponsor_profile_id,winner.sponsor_wallet,winner.confirmed_at,winner.signature_reference,previous?.id || null],
    );
    await client.query("commit");
    return winner;
  } catch (error) { await client.query("rollback").catch(() => {}); throw error; } finally { client.release(); }
}

async function quoteResolution(quoteId) {
  return resolveEventFromQuote(pool, quoteId);
}

async function paymentResolution(paymentId) {
  const row = (await pool.query(
    `select q.id as quote_id from public.sponsorship_payments p join public.sponsorship_payment_quotes q on q.id=p.quote_id where p.id=$1 limit 1`,
    [paymentId],
  )).rows[0];
  return row ? quoteResolution(row.quote_id) : { ok: false, code: "PAYMENT_NOT_FOUND" };
}

async function eventResolution(eventRef) {
  return resolveSponsorableEvent(pool, { eventRef });
}

async function rejectUnlessCanonical(resolution, res) {
  if (resolution?.ok) return false;
  json(res, 409, { ok: false, code: resolution?.code || "EVENT_SPONSORSHIP_IDENTITY_INVALID", error: "Warzone Event Sponsorship identity is not canonical" });
  return true;
}

export default async function handler(req, res) {
  const path = pathOf(req);
  const method = String(req.method || "GET").toUpperCase();
  try {
    if (["/arena/sponsorships/confirm", "/arena/sponsorships/solana-submission", "/arena/sponsorships/solana-expire", "/arena/sponsorships/solana-payment"].includes(path)) {
      if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
      const body = await readJson(req);
      const resolution = await quoteResolution(ident(body.quoteId || body.quote_id));
      if (await rejectUnlessCanonical(resolution, res)) return;

      // Submission starts execution and is forbidden once the canonical event has closed/cancelled.
      // Confirmation/recovery is deliberately still allowed: a payment may have landed before closure/expiry.
      if (path === "/arena/sponsorships/solana-submission" && !resolution.sponsorable) {
        return json(res, 409, { ok: false, code: "EVENT_NOT_SPONSORABLE", reason: resolution.sponsorabilityReason });
      }

      const existing = (await pool.query(`select id,event_sponsorship_id,status,confirmed_at,signature_reference from public.sponsorship_payments where quote_id=$1 and status='confirmed' limit 1`, [resolution.quote.id])).rows[0];
      if (existing && (path === "/arena/sponsorships/confirm" || path === "/arena/sponsorships/solana-payment")) {
        await reconcileFoundingSponsor(resolution.eventId);
        return json(res, 200, { ok: true, idempotent: true, paymentId: existing.id, sponsorshipId: existing.event_sponsorship_id, confirmedAt: existing.confirmed_at, paymentIdentity: existing.signature_reference });
      }

      const result = path === "/arena/sponsorships/confirm" ? await arenaSponsorships(req, res) : await arenaSponsorshipPublic(req, res);
      const confirmed = (await pool.query(`select id from public.sponsorship_payments where quote_id=$1 and status='confirmed' limit 1`, [resolution.quote.id])).rows[0];
      if (confirmed) await reconcileFoundingSponsor(resolution.eventId);
      return result;
    }

    let match = path.match(/^\/arena\/sponsorships\/payments\/([^/]+)$/);
    if (match) {
      const resolution = await paymentResolution(match[1]);
      if (await rejectUnlessCanonical(resolution, res)) return;
      return arenaSponsorshipPublic(req, res);
    }

    match = path.match(/^\/arena\/sponsorships\/([^/]+)\/(state|solana-payment-state)$/);
    if (match) {
      const resolution = await eventResolution(match[1]);
      if (await rejectUnlessCanonical(resolution, res)) return;
      return arenaSponsorshipPublic(req, res);
    }

    return json(res, 404, { ok: false, error: "Unknown event sponsorship recovery route" });
  } catch (error) {
    console.error("[api/arenaEventSponsorshipRecovery]", error);
    return json(res, 503, { ok: false, error: "Event sponsorship recovery is unavailable", detail: String(error?.message || error) });
  }
}
