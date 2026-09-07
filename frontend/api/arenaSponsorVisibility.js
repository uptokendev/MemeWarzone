import { pool } from "../server/db.js";
import { badMethod, json } from "../server/http.js";
import { ELIGIBLE_EVENT_SPONSORSHIP_TYPES, resolveSponsorableEvent } from "./lib/eventSponsorshipAuthority.mjs";

function text(value) {
  return String(value || "").trim();
}

function safeHttpsUrl(value) {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeEventShape(resolution) {
  return {
    eventType: String(resolution.eventType),
    eventReferenceId: String(resolution.eventReferenceId),
    chainId: Number(resolution.chainId),
  };
}

async function resolveExactEvent(query) {
  const eventType = text(query.get("eventType"));
  const eventReferenceId = text(query.get("eventReferenceId"));
  const eventId = text(query.get("eventId"));
  const chainRaw = text(query.get("chainId"));
  const chainId = chainRaw ? Number(chainRaw) : null;

  if (chainRaw && (!Number.isInteger(chainId) || chainId <= 0)) {
    return { ok: false, status: 400, code: "EVENT_CHAIN_INVALID" };
  }

  if (eventType || eventReferenceId) {
    if (!eventType || !eventReferenceId) {
      return { ok: false, status: 400, code: "EVENT_TYPE_AND_REFERENCE_REQUIRED" };
    }
    if (!ELIGIBLE_EVENT_SPONSORSHIP_TYPES.has(eventType)) {
      return { ok: false, status: 404, code: "EVENT_CLASS_INELIGIBLE" };
    }

    const params = [eventType, eventReferenceId];
    let chainFilter = "";
    if (chainId != null) {
      params.push(chainId);
      chainFilter = `and chain_id = $${params.length}`;
    }
    const rows = (await pool.query(
      `select id
         from public.sponsorship_events
        where event_type = $1
          and event_reference_id = $2
          ${chainFilter}
        order by created_at asc, id asc
        limit 2`,
      params,
    )).rows;

    if (!rows.length) return { ok: false, status: 404, code: "EVENT_NOT_FOUND" };
    if (rows.length > 1) return { ok: false, status: 409, code: "EVENT_CHAIN_REQUIRED" };

    const resolution = await resolveSponsorableEvent(pool, { eventRef: rows[0].id, chainId });
    return resolution.ok
      ? { ok: true, resolution }
      : { ok: false, status: 404, code: resolution.code || "EVENT_NOT_FOUND" };
  }

  if (!eventId) return { ok: false, status: 400, code: "EVENT_REFERENCE_REQUIRED" };
  const resolution = await resolveSponsorableEvent(pool, { eventRef: eventId, chainId });
  return resolution.ok
    ? { ok: true, resolution }
    : { ok: false, status: 404, code: resolution.code || "EVENT_NOT_FOUND" };
}

function dedupeSponsors(rows) {
  const seen = new Set();
  const sponsors = [];
  for (const row of rows) {
    const sponsorProfileId = text(row.sponsor_profile_id);
    if (!sponsorProfileId || seen.has(sponsorProfileId)) continue;
    seen.add(sponsorProfileId);
    const projectName = text(row.project_name);
    if (!projectName) continue;
    sponsors.push({
      sponsorProfileId,
      projectName,
      logoUrl: safeHttpsUrl(row.logo_url),
      websiteUrl: safeHttpsUrl(row.website_url),
      foundingSponsor: Boolean(row.founding_sponsor),
      foundingSponsorBadge: text(row.founding_sponsor_badge) || null,
    });
  }
  return sponsors;
}

async function handleGet(req, res) {
  const query = new URL(req.url, "http://localhost").searchParams;
  const event = await resolveExactEvent(query);
  res.setHeader("cache-control", "public, max-age=30, stale-while-revalidate=60");

  if (!event.ok) {
    if (event.code === "EVENT_CLASS_INELIGIBLE" || event.code === "EVENT_NOT_FOUND") {
      return json(res, 200, { ok: true, eligible: false, event: null, sponsors: [] });
    }
    return json(res, event.status || 400, { ok: false, code: event.code, sponsors: [] });
  }

  const rows = (await pool.query(
    `select es.sponsor_profile_id,
            sp.project_name,
            sp.logo_url,
            sp.website_url,
            sp.founding_sponsor,
            sp.founding_sponsor_badge,
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
      where es.event_id = $1
        and es.status = 'active'
        and sp.status = 'active'
      order by es.activated_at asc nulls last, es.created_at asc, es.id asc`,
    [event.resolution.eventId],
  )).rows.map((row) => ({
    ...row,
    founding_sponsor: Boolean(row.event_founding_sponsor || row.founding_sponsor),
  }));

  return json(res, 200, {
    ok: true,
    eligible: true,
    event: safeEventShape(event.resolution),
    sponsors: dedupeSponsors(rows),
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
