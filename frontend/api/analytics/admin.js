import { pool } from "../../server/db.js";
import { requireDashboardAdmin } from "../dashboard/_auth.js";
import launchpadKpis from "./launchpad.js";
import analyticsFunnels from "./funnels.js";

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

function parseWindow(req) {
  const fromRaw = String(req.query?.from || "").trim();
  const toRaw = String(req.query?.to || "").trim();
  const app = String(req.query?.app || "public").trim() || "public";
  const to = toRaw && !Number.isNaN(new Date(toRaw).getTime()) ? new Date(toRaw) : new Date();
  const from = fromRaw && !Number.isNaN(new Date(fromRaw).getTime())
    ? new Date(fromRaw)
    : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString(), app };
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

async function overview(from, to, app) {
  const params = [from, to];
  const extra = appFilter(app, params);
  const [dau, sessions, pageviews, bounce, live, topPages, topEvents, vitals, series] = await Promise.all([
    pool.query(
      `select count(distinct anonymous_id)::int as n
         from public.analytics_events
        where ts >= $1 and ts < $2 ${extra}`,
      params,
    ),
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
    pool.query(
      `select name, count(*)::int as count
         from public.analytics_events
        where ts >= $1 and ts < $2 ${extra}
          and name not in ('$heartbeat')
        group by name
        order by count desc
        limit 10`,
      params,
    ),
    pool.query(
      `select properties->>'metric' as metric,
              percentile_cont(0.75) within group (order by (properties->>'value')::double precision) as p75
         from public.analytics_events
        where name = '$web_vital' and ts >= $1 and ts < $2 ${extra}
          and properties ? 'metric'
        group by 1`,
      params,
    ),
    pool.query(
      `select date_trunc('hour', ts) as bucket,
              count(*) filter (where name = '$pageview')::int as pageviews,
              count(distinct session_id)::int as sessions
         from public.analytics_events
        where ts >= $1 and ts < $2 ${extra}
        group by 1
        order by 1`,
      params,
    ),
  ]);

  const bounced = bounce.rows[0]?.bounced || 0;
  const total = bounce.rows[0]?.total || 0;
  return {
    from,
    to,
    app,
    dau: dau.rows[0]?.n || 0,
    sessions: sessions.rows[0]?.n || 0,
    pageviews: pageviews.rows[0]?.n || 0,
    bounceRate: total ? bounced / total : 0,
    liveUsers: live,
    topPages: topPages.rows.map((row) => ({ path: row.path, views: row.views, uniques: row.uniques })),
    topEvents: topEvents.rows.map((row) => ({ name: row.name, count: row.count })),
    vitals: vitals.rows.map((row) => ({ metric: row.metric, p75: row.p75 == null ? null : Number(row.p75) })),
    series: series.rows.map((row) => ({
      bucket: new Date(row.bucket).toISOString(),
      pageviews: row.pageviews,
      sessions: row.sessions,
    })),
  };
}

async function pages(from, to, app) {
  const params = [from, to];
  const extra = appFilter(app, params);
  const views = await pool.query(
    `select path_template as path,
            count(*)::int as views,
            count(distinct anonymous_id)::int as uniques
       from public.analytics_events
      where name = '$pageview' and ts >= $1 and ts < $2 ${extra}
      group by path_template
      order by views desc
      limit 200`,
    params,
  );
  const durations = await pool.query(
    `select path_template as path,
            avg((properties->>'duration_ms')::double precision) as avg_ms
       from public.analytics_events
      where name = '$pageleave' and ts >= $1 and ts < $2 ${extra}
      group by path_template`,
    params,
  );
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
  const params = [from, to];
  const extra = appFilter(app, params);
  const result = await pool.query(
    `select name, count(*)::int as count
       from public.analytics_events
      where ts >= $1 and ts < $2 ${extra}
      group by name
      order by count desc
      limit 200`,
    params,
  );
  return { rows: result.rows.map((row) => ({ name: row.name, count: row.count })) };
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

async function vitals(from, to, app) {
  const params = [from, to];
  const extra = appFilter(app, params);
  const result = await pool.query(
    `select properties->>'metric' as metric,
            count(*)::int as n,
            percentile_cont(0.5) within group (order by (properties->>'value')::double precision) as p50,
            percentile_cont(0.75) within group (order by (properties->>'value')::double precision) as p75,
            percentile_cont(0.95) within group (order by (properties->>'value')::double precision) as p95
       from public.analytics_events
      where name = '$web_vital' and ts >= $1 and ts < $2 ${extra}
        and coalesce(properties->>'metric', '') <> ''
      group by 1
      order by metric`,
    params,
  );
  return {
    rows: result.rows.map((row) => ({
      metric: row.metric,
      n: row.n,
      p50: row.p50 == null ? null : Number(row.p50),
      p75: row.p75 == null ? null : Number(row.p75),
      p95: row.p95 == null ? null : Number(row.p95),
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
  const admin = await requireDashboardAdmin(req, res);
  if (!admin) return;
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { from, to, app } = parseWindow(req);
  const tail = routeTail(req);
  const q = String(req.query?.q || "").trim();
  const name = String(req.query?.name || "").trim();

  try {
    if (!tail || tail === "overview") {
      return res.status(200).json(await overview(from, to, app));
    }
    if (tail === "pages") return res.status(200).json(await pages(from, to, app));
    if (tail === "events") return res.status(200).json(await events(from, to, app));
    if (tail === "events/details") return res.status(200).json(await eventDetails(from, to, app, name));
    if (tail === "performance/functions") return res.status(200).json(await functions(from, to, app));
    if (tail === "performance/vitals") return res.status(200).json(await vitals(from, to, app));
    if (tail === "realtime") return res.status(200).json(await realtime(app));
    if (tail === "launchpad") {
      return res.status(200).json(await launchpadKpis({ from, to, chainId: req.query?.chainId }));
    }
    if (tail === "funnels") {
      return res.status(200).json(await analyticsFunnels({ from, to, app }));
    }
    if (tail === "sessions") return res.status(200).json(await sessions(app, q));
    const sessionMatch = tail.match(/^sessions\/([0-9a-f-]{36})$/i);
    if (sessionMatch) {
      const detail = await sessionDetail(sessionMatch[1]);
      if (!detail) return res.status(404).json({ error: "Session not found." });
      return res.status(200).json(detail);
    }
    return res.status(404).json({ error: "Unknown analytics route." });
  } catch (error) {
    if (isMissingSchema(error)) {
      return res.status(200).json({
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
      });
    }
    throw error;
  }
}

export default analyticsAdmin;
