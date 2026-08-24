import crypto from "node:crypto";
import { pool } from "../../server/db.js";
import { ANALYTICS_APPS, CATALOG_EVENT_NAMES, MAX_BATCH, MAX_PROPERTY_KEYS, MAX_STRING } from "./catalog.js";
import { isForbiddenEventName, stripForbiddenProperties } from "./denylist.js";
import { templatePath } from "./paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hitsByIp = new Map();

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (forwarded || req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
}

function rateLimitOk(ip) {
  const now = Date.now();
  const recent = (hitsByIp.get(ip) || []).filter((ts) => now - ts < 60_000);
  recent.push(now);
  hitsByIp.set(ip, recent);
  return recent.length <= 120;
}

function writeKeyOk(req) {
  const expected = String(process.env.ANALYTICS_WRITE_KEY || "").trim();
  if (!expected) return false;
  const got = String(req.headers["x-analytics-key"] || req.body?.writeKey || "").trim();
  if (!got || got.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
  } catch {
    return false;
  }
}

function clampString(value) {
  return String(value ?? "").slice(0, MAX_STRING);
}

function parseUa(ua) {
  const s = String(ua || "");
  let browser = "other";
  if (/edg\//i.test(s)) browser = "edge";
  else if (/chrome\//i.test(s)) browser = "chrome";
  else if (/safari/i.test(s)) browser = "safari";
  else if (/firefox/i.test(s)) browser = "firefox";
  let os = "other";
  if (/windows/i.test(s)) os = "windows";
  else if (/android/i.test(s)) os = "android";
  else if (/iphone|ipad|ios/i.test(s)) os = "ios";
  else if (/mac os/i.test(s)) os = "macos";
  else if (/linux/i.test(s)) os = "linux";
  return { browser, os };
}

function hourBucket(date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function sanitizeEvent(raw, req) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "").trim();
  if (!CATALOG_EVENT_NAMES.has(name) || isForbiddenEventName(name)) return null;
  const app = String(raw.app || "").trim();
  if (!ANALYTICS_APPS.has(app)) return null;
  const eventId = String(raw.event_id || "").trim();
  const anonymousId = String(raw.anonymous_id || "").trim();
  const sessionId = String(raw.session_id || "").trim();
  if (!UUID_RE.test(eventId) || !UUID_RE.test(anonymousId) || !UUID_RE.test(sessionId)) return null;

  const ts = new Date(raw.ts || Date.now());
  if (Number.isNaN(ts.getTime())) return null;
  const skewMs = Math.abs(Date.now() - ts.getTime());
  const safeTs = skewMs > 7 * 24 * 60 * 60 * 1000 ? new Date() : ts;

  const page = raw.page && typeof raw.page === "object" ? raw.page : {};
  const pathRaw = clampString(page.path || "/");
  const properties = stripForbiddenProperties(raw.properties);
  const trimmed = {};
  let count = 0;
  for (const [key, value] of Object.entries(properties)) {
    if (count >= MAX_PROPERTY_KEYS) break;
    trimmed[clampString(key)] = typeof value === "string" ? clampString(value) : value;
    count += 1;
  }

  const ip = clientIp(req);
  const salt = String(process.env.ANALYTICS_IP_SALT || process.env.ANALYTICS_WRITE_KEY || "mw-analytics");
  const ipHash = ip ? crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 16) : null;
  const ua = parseUa(req.headers["user-agent"]);
  const incomingContext = raw.context && typeof raw.context === "object" ? raw.context : {};

  return {
    event_id: eventId,
    ts: safeTs.toISOString(),
    name,
    app,
    anonymous_id: anonymousId,
    session_id: sessionId,
    user_id: raw.user_id ? clampString(raw.user_id) : null,
    path_raw: pathRaw,
    path_template: templatePath(pathRaw),
    properties: trimmed,
    context: {
      locale: incomingContext.locale ? clampString(incomingContext.locale) : undefined,
      viewport: incomingContext.viewport,
      utm: incomingContext.utm,
      device: incomingContext.device || undefined,
      browser: ua.browser,
      os: ua.os,
      ip_hash: ipHash,
    },
  };
}

async function persistEvent(client, event) {
  await client.query(
    `insert into public.analytics_events
      (event_id, ts, name, app, anonymous_id, session_id, user_id, path_raw, path_template, properties, context)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)
     on conflict (event_id) do nothing`,
    [
      event.event_id,
      event.ts,
      event.name,
      event.app,
      event.anonymous_id,
      event.session_id,
      event.user_id,
      event.path_raw,
      event.path_template,
      JSON.stringify(event.properties),
      JSON.stringify(event.context),
    ],
  );

  const isPageview = event.name === "$pageview";
  await client.query(
    `insert into public.analytics_sessions
      (session_id, app, anonymous_id, user_id, started_at, last_seen_at, entry_path, exit_path, pageview_count, event_count)
     values ($1,$2,$3,$4,$5,$5,$6,$6,$7,1)
     on conflict (session_id) do update set
       last_seen_at = excluded.last_seen_at,
       user_id = coalesce(public.analytics_sessions.user_id, excluded.user_id),
       exit_path = excluded.exit_path,
       pageview_count = public.analytics_sessions.pageview_count + excluded.pageview_count,
       event_count = public.analytics_sessions.event_count + 1`,
    [
      event.session_id,
      event.app,
      event.anonymous_id,
      event.user_id,
      event.ts,
      event.path_template,
      isPageview ? 1 : 0,
    ],
  );

  const bucket = hourBucket(event.ts);
  await client.query(
    `insert into public.analytics_hourly_events (bucket, app, name, count)
     values ($1,$2,$3,1)
     on conflict (bucket, app, name) do update set count = public.analytics_hourly_events.count + 1`,
    [bucket, event.app, event.name],
  );

  if (isPageview) {
    await client.query(
      `insert into public.analytics_hourly_pages (bucket, app, path_template, views, duration_ms_sum, duration_n)
       values ($1,$2,$3,1,0,0)
       on conflict (bucket, app, path_template) do update set
         views = public.analytics_hourly_pages.views + 1`,
      [bucket, event.app, event.path_template],
    );
  }

  if (event.name === "$pageleave") {
    const duration = Number(event.properties.duration_ms || 0);
    if (Number.isFinite(duration) && duration >= 0) {
      await client.query(
        `insert into public.analytics_hourly_pages (bucket, app, path_template, views, duration_ms_sum, duration_n)
         values ($1,$2,$3,0,$4,1)
         on conflict (bucket, app, path_template) do update set
           duration_ms_sum = public.analytics_hourly_pages.duration_ms_sum + excluded.duration_ms_sum,
           duration_n = public.analytics_hourly_pages.duration_n + 1`,
        [bucket, event.app, event.path_template, Math.round(duration)],
      );
    }
  }

  if (event.name === "$function") {
    const fn = clampString(event.properties.fn || "unknown");
    const ok = event.properties.ok === true ? 1 : 0;
    const duration = Number(event.properties.duration_ms || 0);
    await client.query(
      `insert into public.analytics_hourly_functions (bucket, app, fn, n, ok_n, duration_ms_sum)
       values ($1,$2,$3,1,$4,$5)
       on conflict (bucket, app, fn) do update set
         n = public.analytics_hourly_functions.n + 1,
         ok_n = public.analytics_hourly_functions.ok_n + excluded.ok_n,
         duration_ms_sum = public.analytics_hourly_functions.duration_ms_sum + excluded.duration_ms_sum`,
      [bucket, event.app, fn, ok, Number.isFinite(duration) ? Math.round(duration) : 0],
    );
  }

  if (event.name === "$web_vital") {
    const metric = clampString(event.properties.metric || "");
    const value = Number(event.properties.value);
    if (metric && Number.isFinite(value)) {
      await client.query(
        `insert into public.analytics_hourly_vitals (bucket, app, metric, n, value_sum)
         values ($1,$2,$3,1,$4)
         on conflict (bucket, app, metric) do update set
           n = public.analytics_hourly_vitals.n + 1,
           value_sum = public.analytics_hourly_vitals.value_sum + excluded.value_sum`,
        [bucket, event.app, metric, value],
      );
    }
  }
}

export async function analyticsIngest(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed." });
  }
  if (!writeKeyOk(req)) {
    return res.status(401).json({ ok: false, error: "Invalid analytics write key." });
  }
  const ip = clientIp(req);
  if (!rateLimitOk(ip)) {
    return res.status(429).json({ ok: false, error: "Rate limited." });
  }

  const incoming = Array.isArray(req.body?.events) ? req.body.events : [];
  if (incoming.length === 0) return res.status(200).json({ ok: true, accepted: 0, dropped: 0 });
  const slice = incoming.slice(0, MAX_BATCH);
  const accepted = [];
  let dropped = incoming.length - slice.length;
  for (const raw of slice) {
    const event = sanitizeEvent(raw, req);
    if (event) accepted.push(event);
    else dropped += 1;
  }

  if (accepted.length === 0) return res.status(200).json({ ok: true, accepted: 0, dropped });

  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const event of accepted) {
      await persistEvent(client, event);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    if (error?.code === "42P01" || error?.code === "42703") {
      return res.status(503).json({ ok: false, error: "Analytics schema is not applied." });
    }
    throw error;
  } finally {
    client.release();
  }

  return res.status(200).json({ ok: true, accepted: accepted.length, dropped });
}

export default analyticsIngest;
