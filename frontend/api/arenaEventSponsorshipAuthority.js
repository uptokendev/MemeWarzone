import { pool } from "../server/db.js";
import { badMethod, json, readJson } from "../server/http.js";
import arenaSponsorships from "./arenaSponsorships.js";
import arenaSponsorshipPublic from "./arenaSponsorshipPublic.js";
import { requireAdminOrOps } from "./lib/apiAuth.js";
import { requireWalletActionAuth } from "./lib/walletActionAuth.js";
import {
  ELIGIBLE_EVENT_SPONSORSHIP_TYPES,
  resolveEventFromQuote,
  resolveSponsorableEvent,
  tierMinimumColumnForEventType,
} from "./lib/eventSponsorshipAuthority.mjs";
import {
  assertApplicationTransition,
  canIssueQuote,
  cancellationPolicy,
  deriveSponsorshipState,
  paymentStateFromQuote,
  unresolvedPaymentState,
} from "./lib/eventSponsorshipLifecycle.mjs";

function pathOf(req) { return String(req.path || new URL(req.url, "http://localhost").pathname); }
function queryOf(req) { return new URL(req.url, "http://localhost").searchParams; }
function ident(value) { return String(value || "").trim(); }
function walletPredicate(chainId, column = "sponsor_wallet", position = 1) {
  return Number(chainId) === 101 || Number(chainId) === 102 ? `${column}=$${position}` : `lower(${column})=lower($${position})`;
}

async function activeTier() {
  const snapshot = (await pool.query(`select rolling_30d_qualified_users,active_tier_id from public.sponsorship_traffic_snapshots order by snapshot_date desc,created_at desc limit 1`)).rows[0];
  if (snapshot?.active_tier_id) {
    const tier = (await pool.query(`select * from public.sponsorship_price_tiers where id=$1 and active=true and effective_from<=now() and (effective_until is null or effective_until>now()) limit 1`, [snapshot.active_tier_id])).rows[0];
    if (tier) return tier;
  }
  const users = Number(snapshot?.rolling_30d_qualified_users || 0);
  return (await pool.query(`select * from public.sponsorship_price_tiers where active=true and effective_from<=now() and (effective_until is null or effective_until>now()) and min_qualified_users<=$1 and (max_qualified_users is null or max_qualified_users>=$1) order by sort_order asc limit 1`, [users])).rows[0] || null;
}

async function audit(client, { resolution, applicationId = null, quoteId = null, paymentId = null, wallet = null, action, from = null, to = null, paymentIdentity = null, evidence = {}, actor = null }) {
  await client.query(
    `insert into public.event_sponsorship_audit_log(event_id,application_id,quote_id,payment_id,event_type,chain_id,sponsor_wallet,action,state_from,state_to,payment_identity,evidence,actor)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
    [resolution?.eventId || null, applicationId, quoteId, paymentId, resolution?.eventType || null, resolution?.chainId || null, wallet, action, from, to, paymentIdentity, JSON.stringify(evidence || {}), actor],
  );
}

async function approvedApplication(resolution, wallet) {
  return (await pool.query(
    `select * from public.event_sponsorship_applications
      where event_id=$1 and chain_id=$2 and ${walletPredicate(resolution.chainId, "sponsor_wallet", 3)} and status='approved'
      order by approved_at desc nulls last,created_at desc limit 1`,
    [resolution.eventId, resolution.chainId, wallet],
  )).rows[0] || null;
}

async function latestQuote(resolution, wallet) {
  return (await pool.query(
    `select q.*,p.status as payment_status,p.confirmed_at,p.id as payment_id
       from public.sponsorship_payment_quotes q
       left join lateral (select id,status,confirmed_at from public.sponsorship_payments where quote_id=q.id order by confirmed_at desc nulls last,created_at desc limit 1) p on true
      where q.event_id=$1 and q.chain_id=$2 and ${walletPredicate(resolution.chainId, "q.sponsor_wallet", 3)}
      order by q.created_at desc limit 1`,
    [resolution.eventId, resolution.chainId, wallet],
  )).rows[0] || null;
}

async function gateQuote(req, res, body) {
  const resolution = await resolveSponsorableEvent(pool, { eventRef: body.eventId || body.eventReferenceId, chainId: body.chainId ?? null });
  if (!resolution.ok) return { sent: true, value: json(res, 409, { ok: false, code: resolution.code, error: "Event is not eligible for Warzone Event Sponsorship" }) };
  if (!resolution.sponsorable) return { sent: true, value: json(res, 409, { ok: false, code: "SPONSORSHIP_CLOSED", reason: resolution.sponsorabilityReason }) };
  const wallet = ident(body.walletAddress || body.auth?.walletAddress);
  if (!wallet) return { sent: true, value: json(res, 400, { ok: false, code: "SPONSORSHIP_WALLET_REQUIRED" }) };
  const application = await approvedApplication(resolution, wallet);
  if (!application) return { sent: true, value: json(res, 403, { ok: false, code: "EVENT_SPONSORSHIP_APPLICATION_NOT_APPROVED", error: "An approved event sponsorship application is required" }) };
  const prior = await latestQuote(resolution, wallet);
  const decision = canIssueQuote({ applicationStatus: application.status, existingPaymentState: paymentStateFromQuote(prior), eventSponsorable: resolution.sponsorable });
  if (!decision.ok) return { sent: true, value: json(res, 409, { ok: false, code: decision.code, paymentState: paymentStateFromQuote(prior) }) };
  return { sent: false, resolution, application, wallet };
}

async function linkLatestQuote(gate) {
  if (!gate?.application || !gate?.resolution || !gate?.wallet) return;
  await pool.query(
    `with latest as (
       select id from public.sponsorship_payment_quotes
        where event_id=$1 and chain_id=$2 and ${walletPredicate(gate.resolution.chainId, "sponsor_wallet", 3)}
        order by created_at desc limit 1
     )
     update public.sponsorship_payment_quotes q
        set event_sponsorship_application_id=$4
       from latest where q.id=latest.id and q.event_sponsorship_application_id is null`,
    [gate.resolution.eventId, gate.resolution.chainId, gate.wallet, gate.application.id],
  );
}

async function handleEligibleEvents(_req, res) {
  const rows = (await pool.query(`select id from public.sponsorship_events where event_type=any($1::text[]) order by starts_at asc nulls last,created_at desc`, [[...ELIGIBLE_EVENT_SPONSORSHIP_TYPES]])).rows;
  const tier = await activeTier();
  const events = [];
  for (const row of rows) {
    const resolution = await resolveSponsorableEvent(pool, { eventRef: row.id });
    if (!resolution.ok) continue;
    let minimumUsdCents = null;
    if (tier) minimumUsdCents = String(tier[tierMinimumColumnForEventType(resolution.eventType)] ?? "");
    events.push({ ...resolution, minimumUsdCents: minimumUsdCents || null, tier: tier ? { id: tier.id, code: tier.code } : null, allocation: { prizeBps: 7000, marketingBps: 2000, protocolBps: 1000 } });
  }
  res.setHeader("cache-control", "no-store");
  return json(res, 200, { ok: true, events, individualBattleSponsorship: false, quarterlyChampionshipSponsorship: false });
}

async function handleApply(req, res) {
  const body = await readJson(req);
  const resolution = await resolveSponsorableEvent(pool, { eventRef: body.eventId || body.eventReferenceId, chainId: body.chainId ?? null });
  if (!resolution.ok || !resolution.sponsorable) return json(res, 409, { ok: false, code: resolution.code || "SPONSORSHIP_CLOSED" });
  const wallet = ident(body.walletAddress || body.auth?.walletAddress);
  if (!wallet) return json(res, 400, { ok: false, code: "SPONSORSHIP_WALLET_REQUIRED" });
  const profile = (await pool.query(`select id,status from public.sponsor_profiles where verified_wallet is not null and ${walletPredicate(resolution.chainId, "verified_wallet", 1)} order by created_at desc limit 1`, [wallet])).rows[0];
  if (!profile) return json(res, 403, { ok: false, code: "SPONSOR_PROFILE_REQUIRED" });
  const auth = await requireWalletActionAuth({ res, pool, auth: body.auth || body, expectedWallet: wallet, chainId: resolution.chainId, action: "arena_event_sponsorship_apply", routeLabel: "arena/sponsorships/applications", extraLines: [`Event: ${resolution.eventId}`, `Canonical: ${resolution.canonical.kind}`] });
  if (!auth || auth.legacy) return auth?.legacy ? json(res, 401, { ok: false, error: "Signed wallet authentication is required" }) : undefined;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const item = (await client.query(
      `insert into public.event_sponsorship_applications(event_id,chain_id,sponsor_profile_id,sponsor_wallet,status,brand_name,contact_name,contact_email,creative_url,cta_url)
       values($1,$2,$3,$4,'submitted',$5,$6,$7,$8,$9) returning *`,
      [resolution.eventId, resolution.chainId, profile.id, wallet, ident(body.brandName) || null, ident(body.contactName) || null, ident(body.contactEmail) || null, ident(body.creativeUrl) || null, ident(body.ctaUrl) || null],
    )).rows[0];
    await audit(client, { resolution, applicationId: item.id, wallet, action: "application_submitted", to: "submitted", actor: wallet, evidence: { canonical: resolution.canonical } });
    await client.query("commit");
    return json(res, 201, { ok: true, application: { id: item.id, eventId: resolution.eventId, eventType: resolution.eventType, chainId: resolution.chainId, status: item.status } });
  } catch (error) { await client.query("rollback").catch(() => {}); throw error; } finally { client.release(); }
}

async function handleOwnerState(req, res) {
  const q = queryOf(req);
  const resolution = await resolveSponsorableEvent(pool, { eventRef: q.get("eventId") || q.get("eventReferenceId"), chainId: q.get("chainId") });
  if (!resolution.ok) return json(res, 404, { ok: false, code: resolution.code });
  const wallet = ident(q.get("walletAddress") || q.get("wallet"));
  const authInput = Object.fromEntries(q.entries());
  authInput.walletAddress = wallet;
  const auth = await requireWalletActionAuth({ res, pool, auth: authInput, expectedWallet: wallet, chainId: resolution.chainId, action: "arena_event_sponsorship_state", routeLabel: "arena/sponsorships/owner-state", extraLines: [`Event: ${resolution.eventId}`] });
  if (!auth || auth.legacy) return auth?.legacy ? json(res, 401, { ok: false, error: "Signed wallet authentication is required" }) : undefined;
  const application = (await pool.query(`select id,status,review_reason,approved_at,rejected_at,cancelled_at from public.event_sponsorship_applications where event_id=$1 and chain_id=$2 and ${walletPredicate(resolution.chainId, "sponsor_wallet", 3)} order by created_at desc limit 1`, [resolution.eventId, resolution.chainId, wallet])).rows[0] || null;
  const quote = await latestQuote(resolution, wallet);
  const paymentState = paymentStateFromQuote(quote);
  return json(res, 200, { ok: true, event: resolution, application, quote: quote ? { id: quote.id, expiresAt: quote.expires_at, requestedNativeRaw: String(quote.requested_native_raw), requestedUsdCents: String(quote.requested_usd_cents) } : null, payment: { state: paymentState, unresolved: unresolvedPaymentState(paymentState), confirmedAt: quote?.confirmed_at || null }, sponsorshipState: deriveSponsorshipState({ applicationStatus: application?.status, paymentState, eventCancelled: ["cancelled"].includes(String(resolution.canonicalState).toLowerCase()) }) });
}

async function handlePublicSponsors(req, res) {
  const q = queryOf(req);
  const resolution = await resolveSponsorableEvent(pool, { eventRef: q.get("eventId") || q.get("eventReferenceId"), chainId: q.get("chainId") });
  if (!resolution.ok) return json(res, 404, { ok: false, code: resolution.code });
  const rows = (await pool.query(
    `select es.id as sponsorship_id,es.prize_native_raw,es.marketing_native_raw,es.protocol_native_raw,sp.project_name,p.id as payment_id,p.confirmed_at,p.signature_reference,
            exists(select 1 from public.event_sponsorship_founding_history fh where fh.event_id=es.event_id and fh.payment_id=p.id) as founding_sponsor
       from public.event_sponsorships es
       join public.sponsor_profiles sp on sp.id=es.sponsor_profile_id
       join lateral (select id,confirmed_at,signature_reference from public.sponsorship_payments where event_sponsorship_id=es.id and status='confirmed' order by confirmed_at asc limit 1) p on true
      where es.event_id=$1 and es.status in ('active','completed')
      order by p.confirmed_at asc,p.signature_reference asc`,
    [resolution.eventId],
  )).rows;
  return json(res, 200, { ok: true, event: resolution, sponsors: rows.map((r) => ({ sponsorshipId: r.sponsorship_id, projectName: r.project_name, foundingSponsor: Boolean(r.founding_sponsor), confirmedAt: r.confirmed_at, prizeNativeRaw: String(r.prize_native_raw || 0), marketingNativeRaw: String(r.marketing_native_raw || 0), protocolNativeRaw: String(r.protocol_native_raw || 0) })) });
}

async function handleAdminApplications(req, res) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "admin/arena/event-sponsorship/applications", allowOps: true });
  if (!admin) return;
  const rows = (await pool.query(`select a.*,e.event_type,e.event_reference_id from public.event_sponsorship_applications a join public.sponsorship_events e on e.id=a.event_id order by a.created_at desc limit 500`)).rows;
  return json(res, 200, { ok: true, items: rows });
}

async function handleAdminReview(req, res, applicationId) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "admin/arena/event-sponsorship/review", allowOps: true });
  if (!admin) return;
  const body = await readJson(req);
  const action = String(body.action || "").toLowerCase();
  if (!["under_review", "approved", "rejected", "cancelled"].includes(action)) return json(res, 400, { ok: false, error: "Unsupported review action" });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const current = (await client.query(`select * from public.event_sponsorship_applications where id=$1 for update`, [applicationId])).rows[0];
    if (!current) { await client.query("rollback"); return json(res, 404, { ok: false, error: "Application not found" }); }
    try { assertApplicationTransition(current.status, action); } catch (error) { await client.query("rollback"); return json(res, 409, { ok: false, error: error.message }); }
    const resolution = await resolveSponsorableEvent(client, { eventRef: current.event_id, chainId: current.chain_id });
    if (action === "approved" && (!resolution.ok || !resolution.sponsorable)) { await client.query("rollback"); return json(res, 409, { ok: false, code: resolution.code || "EVENT_NOT_SPONSORABLE" }); }
    const item = (await client.query(`update public.event_sponsorship_applications set status=$2,review_reason=$3,reviewed_by=$4,reviewed_at=now(),approved_at=case when $2='approved' then now() else approved_at end,rejected_at=case when $2='rejected' then now() else rejected_at end,cancelled_at=case when $2='cancelled' then now() else cancelled_at end,updated_at=now() where id=$1 returning *`, [applicationId, action, ident(body.reason) || null, String(admin.mode || "ops")])).rows[0];
    await audit(client, { resolution, applicationId, wallet: current.sponsor_wallet, action: `application_${action}`, from: current.status, to: action, actor: String(admin.mode || "ops"), evidence: { reason: ident(body.reason) || null } });
    await client.query("commit");
    return json(res, 200, { ok: true, item, activatesSponsor: false });
  } catch (error) { await client.query("rollback").catch(() => {}); throw error; } finally { client.release(); }
}

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
      [winner.event_id, winner.event_sponsorship_id, winner.payment_id, winner.sponsor_profile_id, winner.sponsor_wallet, winner.confirmed_at, winner.signature_reference, previous?.id || null],
    );
    await client.query("commit");
    return winner;
  } catch (error) { await client.query("rollback").catch(() => {}); throw error; } finally { client.release(); }
}

async function gateExistingQuote(body, res) {
  const quoteId = ident(body.quoteId || body.quote_id);
  const resolution = await resolveEventFromQuote(pool, quoteId);
  if (!resolution.ok) { json(res, 409, { ok: false, code: resolution.code, error: "Quote is not bound to an eligible canonical event" }); return null; }
  if (resolution.quote?.expires_at && new Date(resolution.quote.expires_at).getTime() <= Date.now()) { json(res, 409, { ok: false, code: "SPONSORSHIP_QUOTE_EXPIRED" }); return null; }
  return resolution;
}

async function handleAdminAudit(req, res) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "admin/arena/event-sponsorship/audit", allowOps: true });
  if (!admin) return;
  const q = queryOf(req);
  const eventId = ident(q.get("eventId"));
  const rows = eventId ? (await pool.query(`select * from public.event_sponsorship_audit_log where event_id=$1 order by created_at desc limit 1000`, [eventId])).rows : (await pool.query(`select * from public.event_sponsorship_audit_log order by created_at desc limit 1000`)).rows;
  return json(res, 200, { ok: true, items: rows });
}

async function handleAdminReconcile(req, res) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "admin/arena/event-sponsorship/reconcile", allowOps: true });
  if (!admin) return;
  const body = await readJson(req);
  const quoteId = ident(body.quoteId);
  const resolution = await resolveEventFromQuote(pool, quoteId);
  if (!resolution.ok) return json(res, 409, { ok: false, code: resolution.code });
  const row = (await pool.query(`select q.*,p.id as payment_id,p.status as payment_status,p.confirmed_at from public.sponsorship_payment_quotes q left join lateral(select id,status,confirmed_at from public.sponsorship_payments where quote_id=q.id order by confirmed_at desc nulls last limit 1)p on true where q.id=$1`, [quoteId])).rows[0];
  const state = paymentStateFromQuote(row);
  if (state === "confirmed") await reconcileFoundingSponsor(resolution.eventId);
  return json(res, 200, { ok: true, event: resolution, quoteId, paymentState: state, unresolved: unresolvedPaymentState(state), automaticRefund: false, cancellation: cancellationPolicy({ paymentState: state }) });
}

export default async function handler(req, res) {
  const path = pathOf(req);
  const method = String(req.method || "GET").toUpperCase();
  try {
    if (path === "/arena/sponsorships/eligible-events" || path === "/arena/sponsorships/options") return method === "GET" ? handleEligibleEvents(req, res) : badMethod(res);
    if (path === "/arena/sponsorships/applications") return method === "POST" ? handleApply(req, res) : badMethod(res);
    if (path === "/arena/sponsorships/owner-state") return method === "GET" ? handleOwnerState(req, res) : badMethod(res);
    if (path === "/arena/sponsorships/public-sponsors") return method === "GET" ? handlePublicSponsors(req, res) : badMethod(res);
    if (path === "/arena/sponsorships/admin/applications") return method === "GET" ? handleAdminApplications(req, res) : badMethod(res);
    let match = path.match(/^\/arena\/sponsorships\/admin\/applications\/([^/]+)\/review$/);
    if (match) return method === "POST" ? handleAdminReview(req, res, match[1]) : badMethod(res);
    if (path === "/arena/sponsorships/admin/audit") return method === "GET" ? handleAdminAudit(req, res) : badMethod(res);
    if (path === "/arena/sponsorships/admin/reconcile") return method === "POST" ? handleAdminReconcile(req, res) : badMethod(res);

    if (path === "/arena/sponsorships/quote" || path === "/arena/sponsorships/solana-quote") {
      if (method !== "POST") return badMethod(res);
      const body = await readJson(req);
      const gate = await gateQuote(req, res, body);
      if (gate.sent) return gate.value;
      const result = path.endsWith("solana-quote") ? await arenaSponsorshipPublic(req, res) : await arenaSponsorships(req, res);
      await linkLatestQuote(gate);
      return result;
    }

    if (["/arena/sponsorships/confirm", "/arena/sponsorships/solana-submission", "/arena/sponsorships/solana-expire", "/arena/sponsorships/solana-payment"].includes(path)) {
      if (method !== "POST") return badMethod(res);
      const body = await readJson(req);
      const resolution = await gateExistingQuote(body, res);
      if (!resolution) return;
      if (path === "/arena/sponsorships/confirm") {
        const existing = (await pool.query(`select id,event_sponsorship_id,confirmed_at,signature_reference from public.sponsorship_payments where quote_id=$1 and status='confirmed' limit 1`, [resolution.quote.id])).rows[0];
        if (existing) return json(res, 200, { ok: true, idempotent: true, paymentId: existing.id, sponsorshipId: existing.event_sponsorship_id, confirmedAt: existing.confirmed_at, paymentIdentity: existing.signature_reference });
      }
      const result = path === "/arena/sponsorships/confirm" ? await arenaSponsorships(req, res) : await arenaSponsorshipPublic(req, res);
      const confirmed = (await pool.query(`select id from public.sponsorship_payments where quote_id=$1 and status='confirmed' limit 1`, [resolution.quote.id])).rows[0];
      if (confirmed) await reconcileFoundingSponsor(resolution.eventId);
      return result;
    }

    // Legacy readback remains available only behind canonical event identity in its own handler.
    if (/^\/arena\/sponsorships\/payments\/[^/]+$/.test(path) || /^\/arena\/sponsorships\/[^/]+\/(?:state|solana-payment-state)$/.test(path)) return arenaSponsorshipPublic(req, res);
    return json(res, 404, { ok: false, error: "Unknown Warzone Event Sponsorship route" });
  } catch (error) {
    console.error("[api/arenaEventSponsorshipAuthority]", error);
    return json(res, 503, { ok: false, error: "Warzone Event Sponsorship authority is unavailable", detail: String(error?.message || error) });
  }
}
