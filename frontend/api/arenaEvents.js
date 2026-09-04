import { pool } from "../server/db.js";
import { badMethod, json, readJson } from "../server/http.js";
import { requireAdminOrOps, isAuthEnforceArenaMutations } from "./lib/apiAuth.js";

const TRANSITIONS = { scheduled: ["deploying", "live"], deploying: ["live"], live: ["completed"], completed: [] };
const STAGES = ["registration", "quarterfinals", "semifinals", "finals", "completed"];
const TYPES = new Set(["battle_weekend", "battle_night", "featured_rivalry", "tournament", "seasonal_league"]);
const STATUSES = new Set(["scheduled", "deploying", "live", "completed"]);

function nowIso() {
  return new Date().toISOString();
}

function futureIso(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function normalizeType(value) {
  const type = String(value || "battle_night");
  return TYPES.has(type) ? type : "battle_night";
}

function normalizeStatus(value) {
  const status = String(value || "scheduled");
  return STATUSES.has(status) ? status : "scheduled";
}

function defaultStage(event) {
  if (event.type !== "tournament") return undefined;
  if (event.status === "completed") return "completed";
  if (event.status === "live") return "quarterfinals";
  return "registration";
}

function mapEvent(row) {
  if (!row) return null;
  const event = {
    id: String(row.id),
    type: normalizeType(row.type),
    title: String(row.title || "Arena Event"),
    status: normalizeStatus(row.status),
    startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : nowIso(),
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : futureIso(180),
    participantCount: Number(row.participant_count || 0),
    summary: String(row.summary || ""),
    bracketStage: row.bracket_stage || undefined,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : undefined,
  };
  event.bracketStage = STAGES.includes(event.bracketStage) ? event.bracketStage : defaultStage(event);
  if (!event.bracketStage) delete event.bracketStage;
  if (!event.completedAt) delete event.completedAt;
  return event;
}

async function listEvents() {
  const result = await pool.query(
    `select id, type, title, status, starts_at, ends_at, participant_count, summary, bracket_stage, completed_at, created_at, updated_at
       from public.arena_events
      where type <> 'tournament'
      order by starts_at asc, created_at asc`,
  );
  return result.rows.map(mapEvent).filter(Boolean);
}

async function findEvent(id) {
  const result = await pool.query(
    `select id, type, title, status, starts_at, ends_at, participant_count, summary, bracket_stage, completed_at, created_at, updated_at
       from public.arena_events where id = $1 limit 1`,
    [id],
  );
  return mapEvent(result.rows?.[0]);
}

async function updateEvent(eventId, patch) {
  const result = await pool.query(
    `update public.arena_events
        set status = coalesce($2, status), starts_at = coalesce($3, starts_at), ends_at = coalesce($4, ends_at),
            participant_count = coalesce($5, participant_count), bracket_stage = $6, completed_at = $7, updated_at = now()
      where id = $1
      returning id, type, title, status, starts_at, ends_at, participant_count, summary, bracket_stage, completed_at, created_at, updated_at`,
    [eventId, patch.status ?? null, patch.startsAt ?? null, patch.endsAt ?? null, Number.isFinite(Number(patch.participantCount)) ? Number(patch.participantCount) : null, patch.bracketStage ?? null, patch.completedAt ?? null],
  );
  return mapEvent(result.rows?.[0]);
}

async function handleList(_req, res) {
  try {
    const events = await listEvents();
    return json(res, 200, { events: events.filter((event) => event.status !== "completed"), archivedEvents: events.filter((event) => event.status === "completed" && event.completedAt) });
  } catch (error) {
    console.error("[api/arenaEvents] list failed", error);
    return json(res, 200, { events: [], archivedEvents: [], warning: "Arena event data is unavailable." });
  }
}

async function handleTransition(req, res, eventId) {
  const admin = await requireAdminOrOps(req, res, { routeLabel: "arena/events/transition", allowOps: true });
  if (!admin) return;
  if (admin.mode === "legacy-open" && isAuthEnforceArenaMutations()) {
    return json(res, 401, { ok: false, error: "Admin or ops auth required." });
  }
  const event = await findEvent(eventId);
  if (!event) return json(res, 404, { ok: false, error: "Event not found" });
  const body = await readJson(req);
  const nextStatus = String(body?.status || "");
  if (!(TRANSITIONS[event.status] || []).includes(nextStatus)) return json(res, 409, { ok: false, error: "Invalid event transition", currentStatus: event.status });

  const patch = { status: nextStatus, startsAt: event.startsAt, endsAt: event.endsAt, participantCount: event.participantCount, bracketStage: event.bracketStage, completedAt: nextStatus === "completed" ? nowIso() : null };
  if (nextStatus === "deploying") patch.startsAt = futureIso(20);
  if (nextStatus === "live") {
    patch.startsAt = nowIso();
    patch.endsAt = futureIso(180);
    if (event.type === "tournament" && (!patch.bracketStage || patch.bracketStage === "registration")) patch.bracketStage = "quarterfinals";
  }
  if (nextStatus === "completed") {
    patch.endsAt = nowIso();
    if (event.type === "tournament") patch.bracketStage = "completed";
  }
  return json(res, 200, { ok: true, event: await updateEvent(eventId, patch) });
}

async function handleAdvanceBracket(_req, res, eventId) {
  const event = await findEvent(eventId);
  if (!event || event.type !== "tournament") return json(res, 404, { ok: false, error: "Tournament event not found" });
  const currentStage = event.bracketStage || defaultStage(event) || "registration";
  const index = STAGES.indexOf(currentStage);
  if (index < 0 || index >= STAGES.length - 1) return json(res, 409, { ok: false, error: "Tournament bracket cannot advance", currentStage });
  const nextStage = STAGES[index + 1];
  const patch = { status: nextStage === "completed" ? "completed" : event.status === "scheduled" || event.status === "deploying" ? "live" : event.status, startsAt: event.status === "scheduled" || event.status === "deploying" ? nowIso() : event.startsAt, endsAt: nextStage === "completed" ? nowIso() : event.endsAt, participantCount: event.participantCount, bracketStage: nextStage, completedAt: nextStage === "completed" ? nowIso() : null };
  return json(res, 200, { ok: true, event: await updateEvent(eventId, patch) });
}

export default async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.path || new URL(req.url, "http://localhost").pathname);
  try {
    if (method === "GET" && path === "/arena/events") return handleList(req, res);
    const advance = path.match(/^\/arena\/events\/([^/]+)\/advance-bracket$/);
    if (advance) return method === "POST" ? handleAdvanceBracket(req, res, decodeURIComponent(advance[1])) : badMethod(res);
    const transition = path.match(/^\/arena\/events\/([^/]+)\/transition$/);
    if (transition) return method === "POST" ? handleTransition(req, res, decodeURIComponent(transition[1])) : badMethod(res);
    const detail = path.match(/^\/arena\/events\/([^/]+)$/);
    if (detail) {
      if (method !== "GET") return badMethod(res);
      const event = await findEvent(decodeURIComponent(detail[1]));
      return event ? json(res, 200, { event }) : json(res, 404, { error: "Event not found" });
    }
    return json(res, 404, { error: `Unknown arena events route: ${path}` });
  } catch (error) {
    console.error("[api/arenaEvents] request failed", error);
    return json(res, 503, { ok: false, error: "Arena event storage is unavailable", detail: String(error?.message || error || "unknown error") });
  }
}
