import { pool } from "../server/db.js";
import { badMethod, json } from "../server/http.js";
import {
  PUBLIC_SPONSOR_EVENT_TYPES,
  canonicalPublicSponsorEventType,
  projectPublicSponsors,
  publicSponsorRegistryTypes,
} from "./lib/arenaSponsorVisibilityPolicy.mjs";

const VISIBLE_EVENT_TYPES = new Set(PUBLIC_SPONSOR_EVENT_TYPES);

function text(value) {
  return String(value || "").trim();
}

function publicEventShape(rows, canonicalType) {
  const row = rows[0];
  return {
    eventType: canonicalType,
    eventReferenceId: String(row.event_reference_id),
    chainId: Number(row.chain_id),
  };
}

async function rowsForCanonicalIdentity({ eventType, eventReferenceId, chainId }) {
  const registryTypes = publicSponsorRegistryTypes(eventType);
  const params = [eventReferenceId, registryTypes];
  let chainFilter = "";
  if (chainId != null) {
    params.push(chainId);
    chainFilter = `and chain_id = $${params.length}`;
  }
  return (await pool.query(
    `select id,event_type,event_reference_id,chain_id,created_at
       from public.sponsorship_events
      where event_reference_id = $1
        and event_type = any($2::text[])
        ${chainFilter}
      order by chain_id asc,created_at asc,id asc`,
    params,
  )).rows;
}

async function resolveExactEvent(query) {
  const requestedEventType = text(query.get("eventType"));
  const eventReferenceId = text(query.get("eventReferenceId"));
  const eventId = text(query.get("eventId"));
  const chainRaw = text(query.get("chainId"));
  const chainId = chainRaw ? Number(chainRaw) : null;

  if (chainRaw && (!Number.isInteger(chainId) || chainId <= 0)) {
    return { ok: false, status: 400, code: "EVENT_CHAIN_INVALID" };
  }

  let canonicalType;
  let reference = eventReferenceId;
  if (requestedEventType || eventReferenceId) {
    if (!requestedEventType || !eventReferenceId) {
      return { ok: false, status: 400, code: "EVENT_TYPE_AND_REFERENCE_REQUIRED" };
    }
    canonicalType = canonicalPublicSponsorEventType(requestedEventType);
    if (!VISIBLE_EVENT_TYPES.has(canonicalType)) {
      return { ok: false, status: 404, code: "EVENT_CLASS_INELIGIBLE" };
    }
  } else {
    if (!eventId) return { ok: false, status: 400, code: "EVENT_REFERENCE_REQUIRED" };
    const params = [eventId];
    let chainFilter = "";
    if (chainId != null) {
      params.push(chainId);
      chainFilter = `and chain_id = $${params.length}`;
    }
    const direct = (await pool.query(
      `select id,event_type,event_reference_id,chain_id,created_at
         from public.sponsorship_events
        where id::text = $1 ${chainFilter}
        limit 1`,
      params,
    )).rows[0];
    if (!direct) return { ok: false, status: 404, code: "EVENT_NOT_FOUND" };
    canonicalType = canonicalPublicSponsorEventType(direct.event_type);
    if (!VISIBLE_EVENT_TYPES.has(canonicalType)) return { ok: false, status: 404, code: "EVENT_CLASS_INELIGIBLE" };
    reference = String(direct.event_reference_id);
  }

  const rows = await rowsForCanonicalIdentity({ eventType: canonicalType, eventReferenceId: reference, chainId });
  if (!rows.length) return { ok: false, status: 404, code: "EVENT_NOT_FOUND" };
  const chains = new Set(rows.map((row) => Number(row.chain_id)));
  if (chains.size > 1) return { ok: false, status: 409, code: "EVENT_CHAIN_REQUIRED" };
  return { ok: true, canonicalType, events: rows };
}

async function handleGet(req, res) {
  const query = new URL(req.url, "http://localhost").searchParams;
  const resolved = await resolveExactEvent(query);
  res.setHeader("cache-control", "public, max-age=30, stale-while-revalidate=60");

  if (!resolved.ok) {
    if (resolved.code === "EVENT_CLASS_INELIGIBLE" || resolved.code === "EVENT_NOT_FOUND") {
      return json(res, 200, { ok: true, eligible: false, event: null, sponsors: [] });
    }
    return json(res, resolved.status || 400, { ok: false, code: resolved.code, sponsors: [] });
  }

  const eventIds = resolved.events.map((row) => row.id);
  const rows = (await pool.query(
    `select es.sponsor_profile_id,
            es.status as sponsorship_status,
            es.activated_at,
            es.created_at,
            es.id as event_sponsorship_id,
            sp.status as profile_status,
            sp.project_name,
            sp.founding_sponsor,
            exists (
              select 1
                from public.sponsorship_payments p
                join public.event_sponsorship_founding_history fh
                  on fh.event_id = es.event_id
                 and fh.payment_id = p.id
               where p.event_sponsorship_id = es.id
                 and p.status = 'confirmed'
            ) as event_founding_sponsor
       from public.event_sponsorships es
       join public.sponsor_profiles sp
         on sp.id = es.sponsor_profile_id
      where es.event_id = any($1::uuid[])
        and es.status = 'active'
        and sp.status = 'approved'
      order by es.activated_at asc nulls last,es.created_at asc,es.id asc`,
    [eventIds],
  )).rows;

  return json(res, 200, {
    ok: true,
    eligible: true,
    event: publicEventShape(resolved.events, resolved.canonicalType),
    sponsors: projectPublicSponsors(rows),
  });
}

export default async function handler(req, res) {
  if (String(req.method || "GET").toUpperCase() !== "GET") return badMethod(res);
  try {
    return await handleGet(req, res);
  } catch (error) {
    console.error("[arenaSponsorVisibility] failed", error);
    return json(res, 500, { ok: false, code: "SPONSOR_VISIBILITY_UNAVAILABLE", sponsors: [] });
  }
}
