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

async function resolveCanonicalEvent(query) {
  const requestedType = canonicalPublicSponsorEventType(text(query.get("eventType")));
  const reference = text(query.get("eventReferenceId"));
  const chainRaw = text(query.get("chainId"));
  const chainId = chainRaw ? Number(chainRaw) : null;
  if (!requestedType || !reference) return { ok: false, status: 400, code: "EVENT_TYPE_AND_REFERENCE_REQUIRED" };
  if (!VISIBLE_EVENT_TYPES.has(requestedType)) return { ok: false, status: 404, code: "EVENT_CLASS_INELIGIBLE" };
  if (chainRaw && (!Number.isInteger(chainId) || chainId <= 0)) return { ok: false, status: 400, code: "EVENT_CHAIN_INVALID" };

  if (requestedType === "quarterly_championship") {
    const params = [reference];
    let chainFilter = "";
    if (chainId != null) {
      params.push(chainId);
      chainFilter = `and chain_id=$${params.length}`;
    }
    const epochRows = (await pool.query(
      `select id,event_type,chain_id,opens_at,closes_at,state
         from public.arena_championship_epochs
        where id=$1 ${chainFilter}
        limit 2`,
      params,
    )).rows || [];
    if (epochRows.length !== 1 || String(epochRows[0].event_type) !== "quarterly_championship") {
      return { ok: false, status: 404, code: "CHAMPIONSHIP_EPOCH_NOT_FOUND" };
    }
    const epoch = epochRows[0];
    const registryRows = (await pool.query(
      `select id,event_type,event_reference_id,chain_id,starts_at,ends_at,created_at
         from public.sponsorship_events
        where event_reference_id=$1
          and chain_id=$2
          and event_type=any($3::text[])
        order by case when event_type='quarterly_championship' then 0 else 1 end,created_at asc,id asc`,
      [reference, Number(epoch.chain_id), publicSponsorRegistryTypes(requestedType)],
    )).rows || [];
    if (!registryRows.length) return { ok: false, status: 404, code: "EVENT_NOT_FOUND" };
    return { ok: true, canonicalType: requestedType, reference, chainId: Number(epoch.chain_id), events: registryRows, epoch };
  }

  const params = [reference, requestedType];
  let chainFilter = "";
  if (chainId != null) {
    params.push(chainId);
    chainFilter = `and chain_id=$${params.length}`;
  }
  const rows = (await pool.query(
    `select id,event_type,event_reference_id,chain_id,starts_at,ends_at,created_at
       from public.sponsorship_events
      where event_reference_id=$1 and event_type=$2 ${chainFilter}
      order by created_at asc,id asc`,
    params,
  )).rows || [];
  if (!rows.length) return { ok: false, status: 404, code: "EVENT_NOT_FOUND" };
  const chains = new Set(rows.map((row) => Number(row.chain_id)));
  if (chains.size !== 1) return { ok: false, status: 409, code: "EVENT_CHAIN_REQUIRED" };
  return { ok: true, canonicalType: requestedType, reference, chainId: Number(rows[0].chain_id), events: rows, epoch: null };
}

async function handleGet(req, res) {
  const query = new URL(req.url, "http://localhost").searchParams;
  const resolved = await resolveCanonicalEvent(query);
  res.setHeader("cache-control", "public, max-age=30, stale-while-revalidate=60");
  if (!resolved.ok) {
    if (["EVENT_CLASS_INELIGIBLE", "EVENT_NOT_FOUND", "CHAMPIONSHIP_EPOCH_NOT_FOUND"].includes(resolved.code)) {
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
            p.status as payment_status,
            p.confirmed_at,
            (se.ends_at is null or se.ends_at > now()) as event_window_valid,
            exists (
              select 1
                from public.event_sponsorship_founding_history fh
               where fh.event_id=es.event_id and fh.payment_id=p.id
            ) as event_founding_sponsor
       from public.event_sponsorships es
       join public.sponsorship_events se on se.id=es.event_id
       join public.sponsor_profiles sp on sp.id=es.sponsor_profile_id
       join lateral (
         select id,status,confirmed_at
           from public.sponsorship_payments
          where event_sponsorship_id=es.id and status='confirmed'
          order by confirmed_at asc,created_at asc,id asc
          limit 1
       ) p on true
      where es.event_id=any($1::uuid[])
        and es.status='active'
        and sp.status='approved'
        and (se.ends_at is null or se.ends_at > now())
      order by p.confirmed_at asc,es.activated_at asc nulls last,es.created_at asc,es.id asc`,
    [eventIds],
  )).rows || [];

  let projected = projectPublicSponsors(rows);
  if (resolved.epoch) {
    const closesAt = new Date(resolved.epoch.closes_at).getTime();
    if (!Number.isFinite(closesAt) || closesAt <= Date.now()) projected = [];
  }

  return json(res, 200, {
    ok: true,
    eligible: true,
    event: {
      eventType: resolved.canonicalType,
      eventReferenceId: resolved.reference,
      chainId: resolved.chainId,
    },
    sponsors: projected,
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
