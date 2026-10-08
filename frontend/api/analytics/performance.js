import { readRollupCoverage, vitalStats } from "./rollups.js";

function appFilter(app, params) {
  if (app === "public" || app === "admin") {
    params.push(app);
    return `and app = $${params.length}`;
  }
  return "";
}

// Reads analytics_hourly_vital_values for the finished hours the rollup job covers and raw
// $web_vital rows for the rest; percentiles are exact (see rollups.js vitalStats).
export async function analyticsPerformanceVitals({ pool, from, to, app }) {
  const coverage = await readRollupCoverage(pool);
  return { rows: await vitalStats(pool, { from, to, app, coverage }) };
}

export async function analyticsPerformancePages({ pool, from, to, app }) {
  const params = [from, to];
  const extra = appFilter(app, params);
  const result = await pool.query(
    `select path_template as path,
            count(*)::int as n,
            percentile_cont(0.5) within group (order by (properties->>'duration_ms')::double precision) as p50,
            percentile_cont(0.95) within group (order by (properties->>'duration_ms')::double precision) as p95,
            avg((properties->>'duration_ms')::double precision) as avg_ms
       from public.analytics_events
      where name = '$pageleave' and ts >= $1 and ts < $2 ${extra}
        and nullif(properties->>'duration_ms','') is not null
      group by path_template
      order by n desc
      limit 100`,
    params,
  );
  return {
    rows: result.rows.map((row) => ({
      path: row.path,
      n: Number(row.n || 0),
      p50Ms: row.p50 == null ? null : Number(row.p50),
      p95Ms: row.p95 == null ? null : Number(row.p95),
      avgMs: row.avg_ms == null ? null : Number(row.avg_ms),
    })),
  };
}

export async function analyticsPerformanceEnvironment({ pool, from, to, app }) {
  const params = [from, to];
  const extra = appFilter(app, params);
  const result = await pool.query(
    `select coalesce(context->>'device','unknown') as device,
            coalesce(context->>'browser','unknown') as browser,
            coalesce(context->>'os','unknown') as os,
            count(distinct anonymous_id)::int as visitors,
            count(*)::int as pageviews
       from public.analytics_events
      where name = '$pageview' and ts >= $1 and ts < $2 ${extra}
      group by 1,2,3
      order by visitors desc, pageviews desc
      limit 100`,
    params,
  );
  return {
    rows: result.rows.map((row) => ({
      device: row.device,
      browser: row.browser,
      os: row.os,
      visitors: Number(row.visitors || 0),
      pageviews: Number(row.pageviews || 0),
    })),
  };
}
