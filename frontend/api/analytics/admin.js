import { pool } from "../../server/db.js";
import { requireDashboardPermission } from "../dashboard/_access.js";
import launchpadKpis from "./launchpad.js";
import analyticsFunnels from "./funnels.js";
import analyticsGeography from "./geography.js";
import {
  analyticsPerformanceEnvironment,
  analyticsPerformancePages,
  analyticsPerformanceVitals,
} from "./performance.js";
import { analyticsCacheKey, createAnalyticsCache, withRequestWindow } from "./cache.js";
import {
  dailySeries,
  distinctVisitors,
  eventCounts,
  hourlySeries,
  readRollupCoverage,
  vitalStats,
} from "./rollups.js";
import { AnalyticsWindowError, parseWindow } from "./window.js";

const responseCache = createAnalyticsCache();
// Realtime is "the last 5 minutes"; a minute-old answer would hide arrivals, so it gets a short TTL.
const realtimeCache = createAnalyticsCache({ ttlMs: 15_000 });

function isMissingSchema(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function appFilter(app, params) {
  if (app === "public" || app === "admin") {
    params.push(app);
    return `and app = $${params.length}`;
  }
  return "";
}

function routeTail(req) {
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  return path.replace(/^\/api\/admin\/analytics\/?/, "");
}

async function liveUsers(app) {
  const params = [];
  const extra = appFilter(app, params);
  const result = await pool.query(
    `select count(distinct anonymous_id)::int as n
       from public.analytics_events
      where ts >= now() - interval '5 minutes' ${extra}`,
    params,
  );
  return result.rows[0]?.n || 0;
}

async function overview(from, to, app, { granularity = "hour", timeZone = "UTC" } = {}) {
  const params = [from, to];
  const extra = appFilter(app, params);
  const coverage = await readRollupCoverage(pool);
  const [dau, sessions, pageviews, bounce, live, topPages, topEvents, vitals, series] = await Promise.all([
    distinctVisitors(pool, { from, to, app, coverage }),
    pool.query(
      `select count(*)::int as n
         from public.analytics_sessions
        where last_seen_at >= $1 and started_at < $2 ${extra}`,
      params,
    ),
    pool.query(
      `select count(*)::int as n
         from public.analytics_events
        where name = '$pageview' and ts >= $1 and ts < $2 ${extra}`,
      params,
    ),
    pool.query(
      `select
          count(*) filter (where pageview_count <= 1)::int as bounced,
          count(*)::int as total
         from public.analytics_sessions
        where last_seen_at >= $1 and started_at < $2 ${extra}`,
      params,
    ),
    liveUsers(app),
    pool.query(
      `select path_template as path,
              count(*)::int as views,
              count(distinct anonymous_id)::int as uniques
         from public.analytics_events
        where name = '$pageview' and ts >= $1 and ts < $2 ${extra}
        group by path_template
        order by views desc
        limit 10`,
      params,
    ),
    eventCounts(pool, { from, to, app, limit: 10, excludeNames: ["$heartbeat"] }),
    vitalStats(pool, { from, to, app, coverage }),
    granularity === "day"
      ? dailySeries(pool, { from, to, app, coverage, timeZone })
      : hourlySeries(pool, { from, to, app, coverage }),
  ]);

  const bounced = bounce.rows[0]?.bounced || 0;
  const total = bounce.rows[0]?.total || 0;
  return {
    from,
    to,
    app,
    dau,
    sessions: sessions.rows[0]?.n || 0,
    pageviews: pageviews.rows[0]?.n || 0,
    bounceRate: total ? bounced / total : 0,
    liveUsers: live,
    topPages: topPages.rows.map((row) => ({ path: row.path, views: row.views, uniques: row.uniques })),
    topEvents,
    vitals: vitals.map((row) => ({ metric: row.metric, p75: row.p75 })),
    granularity,
    timeZone: granularity === "day" ? timeZone : "UTC",
    series,
  };
}

async function pages(from, to, app) {
  const params = [from, to];
  const extra = appFilter(app, params);
  const [views, durations] = await Promise.all([pool.query(
    `select path_template as path,
            count(*)::int as views,
            count(distinct anonymous_id)::int as uniques
       from public.analytics_events
      where name = '$pageview' and ts >= $1 and ts < $2 ${extra}
      group by path_template
      order by views desc
      limit 200`,
    params,
  ), pool.query(
    `select path_template as path,
            avg((properties->>'duration_ms')::double precision) as avg_ms
       from public.analytics_events
      where name = '$pageleave' and ts >= $1 and ts < $2 ${extra}
      group by path_template`,
    params,
  )]);
  const durationByPath = new Map(durations.rows.map((row) => [row.path, row.avg_ms == null ? null : Number(row.avg_ms)]));
  return {
    rows: views.rows.map((row) => ({
      path: row.path,
      views: row.views,
      uniques: row.uniques,
      avgDurationMs: durationByPath.get(row.path) ?? null,
    })),
  };
}

async function events(from, to, app) {
  return { rows: await eventCounts(pool, { from, to, app, limit: 200 }) };
}

async function eventDetails(from, to, app, name) {
  const params = [from, to];
  const extra = appFilter(app, params);
  let nameFilter = "";
  if (name) {
    params.push(name);
    nameFilter = `and name = $${params.length}`;
  }
  const result = await pool.query(
    `select event_id, ts, name, app, anonymous_id, session_id, user_id,
            path_raw, path_template, properties, context
       from public.analytics_events
      where ts >= $1 and ts < $2 ${extra} ${nameFilter}
      order by ts desc
      limit 500`,
    params,
  );
  return {
    rows: result.rows.map((row) => ({
      eventId: row.event_id,
      ts: new Date(row.ts).toISOString(),
      name: row.name,
      app: row.app,
      anonymousId: row.anonymous_id,
      sessionId: row.session_id,
      userId: row.user_id,
      path: row.path_template || row.path_raw || null,
      pathRaw: row.path_raw || null,
      properties: row.properties || {},
      context: row.context || {},
    })),
  };
}

async function functions(from, to, app) {
  const params = [from, to];
  const extra = appFilter(app, params);
  const result = await pool.query(
    `select properties->>'fn' as fn,
            count(*)::int as n,
            count(*) filter (where (properties->>'ok') = 'true')::int as ok_n,
            percentile_cont(0.5) within group (order by (properties->>'duration_ms')::double precision) as p50,
            percentile_cont(0.95) within group (order by (properties->>'duration_ms')::double precision) as p95
       from public.analytics_events
      where name = '$function' and ts >= $1 and ts < $2 ${extra}
        and coalesce(properties->>'fn', '') <> ''
      group by 1
      order by n desc
      limit 200`,
    params,
  );
  return {
    rows: result.rows.map((row) => ({
      fn: row.fn,
      n: row.n,
      okN: row.ok_n,
      errorRate: row.n ? (row.n - row.ok_n) / row.n : 0,
      p50Ms: row.p50 == null ? null : Number(row.p50),
      p95Ms: row.p95 == null ? null : Number(row.p95),
    })),
  };
}

async function realtime(app) {
  const params = [];
  const extra = appFilter(app, params);
  const liveSql = extra
    ? `select count(distinct anonymous_id)::int as n from public.analytics_events where ts >= now() - interval '5 minutes' ${extra}`
    : `select count(distinct anonymous_id)::int as n from public.analytics_events where ts >= now() - interval '5 minutes'`;
  const [live, pagesRes, recent] = await Promise.all([
    pool.query(liveSql, params),
    pool.query(
      `select path_template as path, count(distinct anonymous_id)::int as users
         from public.analytics_events
        where ts >= now() - interval '5 minutes' ${extra}
        group by path_template
        order by users desc
        limit 20`,
      params,
    ),
    pool.query(
      `select ts, name, path_template as path, user_id, app
         from public.analytics_events
        where ts >= now() - interval '30 minutes' ${extra}
          and name <> '$heartbeat'
        order by ts desc
        limit 40`,
      params,
    ),
  ]);
  return {
    liveUsers: live.rows[0]?.n || 0,
    pages: pagesRes.rows.map((row) => ({ path: row.path, users: row.users })),
    recent: recent.rows.map((row) => ({
      ts: new Date(row.ts).toISOString(),
      name: row.name,
      path: row.path,
      userId: row.user_id,
      app: row.app,
    })),
  };
}

async function sessions(app, q) {
  const params = [];
  const extra = appFilter(app, params);
  let search = "";
  if (q) {
    params.push(`%${q}%`);
    search = `and (user_id ilike $${params.length} or anonymous_id::text ilike $${params.length} or session_id::text ilike $${params.length})`;
  }
  const result = await pool.query(
    `select session_id, app, anonymous_id, user_id, started_at, last_seen_at,
            entry_path, exit_path, pageview_count, event_count
       from public.analytics_sessions
      where last_seen_at >= now() - interval '30 days' ${extra} ${search}
      order by last_seen_at desc
      limit 100`,
    params,
  );
  return {
    rows: result.rows.map((row) => ({
      sessionId: row.session_id,
      app: row.app,
      anonymousId: row.anonymous_id,
      userId: row.user_id,
      startedAt: new Date(row.started_at).toISOString(),
      lastSeenAt: new Date(row.last_seen_at).toISOString(),
      entryPath: row.entry_path,
      exitPath: row.exit_path,
      pageviewCount: row.pageview_count,
      eventCount: row.event_count,
    })),
  };
}

async function sessionDetail(sessionId) {
  const session = await pool.query(
    `select session_id, app, anonymous_id, user_id, started_at, last_seen_at,
            entry_path, exit_path, pageview_count, event_count
       from public.analytics_sessions
      where session_id = $1`,
    [sessionId],
  );
  if (!session.rowCount) return null;
  const eventsRes = await pool.query(
    `select event_id, ts, name, path_template, properties
       from public.analytics_events
      where session_id = $1
      order by ts asc
      limit 500`,
    [sessionId],
  );
  const row = session.rows[0];
  return {
    sessionId: row.session_id,
    app: row.app,
    anonymousId: row.anonymous_id,
    userId: row.user_id,
    startedAt: new Date(row.started_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    entryPath: row.entry_path,
    exitPath: row.exit_path,
    pageviewCount: row.pageview_count,
    eventCount: row.event_count,
    events: eventsRes.rows.map((event) => ({
      eventId: event.event_id,
      ts: new Date(event.ts).toISOString(),
      name: event.name,
      path: event.path_template,
      properties: event.properties || {},
    })),
  };
}

export async function analyticsAdmin(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const tail = routeTail(req);
  const permission = tail === "launchpad" ? "launchpad.view" : "analytics.view";
  const principal = await requireDashboardPermission(req, res, permission);
  if (!principal) return;
  let window;
  try {
    window = parseWindow(req.query || {});
  } catch (error) {
    if (error instanceof AnalyticsWindowError) return res.status(400).json({ error: error.message });
    throw error;
  }
  const { from, to, app, granularity, timeZone } = window;
  const q = String(req.query?.q || "").trim();
  const name = String(req.query?.name || "").trim();

  const cache = tail === "realtime" ? realtimeCache : responseCache;
  const key = analyticsCacheKey({
    route: tail || "overview",
    from,
    to,
    app,
    extra: { q, name, chainId: String(req.query?.chainId ?? ""), granularity, tz: timeZone },
  });

  try {
    const payload = await cache.wrap(key, () => routePayload({ tail, from, to, app, q, name, chainId: req.query?.chainId, granularity, timeZone }));
    if (payload === NOT_FOUND) return res.status(404).json({ error: "Unknown analytics route." });
    if (payload === SESSION_NOT_FOUND) return res.status(404).json({ error: "Session not found." });
    return res.status(200).json(withRequestWindow(payload, { from, to, app }));
  } catch (error) {
    if (isMissingSchema(error)) {
      return res.status(200).json(SCHEMA_MISSING(from, to, app));
    }
    throw error;
  }
}

const NOT_FOUND = Symbol("not-found");
const SESSION_NOT_FOUND = Symbol("session-not-found");

function SCHEMA_MISSING(from, to, app) {
  return {
    schemaMissing: true,
    from,
    to,
    app,
    dau: 0,
    sessions: 0,
    pageviews: 0,
    bounceRate: 0,
    liveUsers: 0,
    topPages: [],
    topEvents: [],
    vitals: [],
    series: [],
    rows: [],
    pages: [],
    recent: [],
    funnels: [],
    countries: [],
    regions: [],
    coverage: { pageviews: 0, locatedPageviews: 0, rate: 0 },
  };
}

async function routePayload({ tail, from, to, app, q, name, chainId, granularity, timeZone }) {
  if (!tail || tail === "overview") return overview(from, to, app, { granularity, timeZone });
  if (tail === "pages") return pages(from, to, app);
  if (tail === "events") return events(from, to, app);
  if (tail === "events/details") return eventDetails(from, to, app, name);
  if (tail === "geography") return analyticsGeography({ pool, from, to, app });
  if (tail === "performance/functions") return functions(from, to, app);
  if (tail === "performance/vitals") return analyticsPerformanceVitals({ pool, from, to, app });
  if (tail === "performance/pages") return analyticsPerformancePages({ pool, from, to, app });
  if (tail === "performance/environment") return analyticsPerformanceEnvironment({ pool, from, to, app });
  if (tail === "realtime") return realtime(app);
  if (tail === "launchpad") return launchpadKpis({ from, to, chainId });
  if (tail === "funnels") return analyticsFunnels({ from, to, app });
  if (tail === "sessions") return sessions(app, q);
  const sessionMatch = tail.match(/^sessions\/([0-9a-f-]{36})$/i);
  if (sessionMatch) {
    const detail = await sessionDetail(sessionMatch[1]);
    return detail || SESSION_NOT_FOUND;
  }
  return NOT_FOUND;
}

// For the read-only production timing script and tests; the route itself is analyticsAdmin.
export { routePayload as analyticsRoutePayload };

export default analyticsAdmin;
