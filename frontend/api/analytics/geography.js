function appFilter(app, params) {
  if (app === "public" || app === "admin") {
    params.push(app);
    return `and app = $${params.length}`;
  }
  return "";
}

export default async function analyticsGeography({ pool, from, to, app }) {
  const params = [from, to];
  const extra = appFilter(app, params);
  const [countries, regions, coverage] = await Promise.all([
    pool.query(
      `select upper(context->>'country') as country,
              count(distinct anonymous_id)::int as visitors,
              count(distinct session_id)::int as sessions,
              count(*)::int as pageviews
         from public.analytics_events
        where name = '$pageview'
          and ts >= $1 and ts < $2 ${extra}
          and coalesce(context->>'country', '') <> ''
        group by 1
        order by visitors desc, pageviews desc
        limit 200`,
      params,
    ),
    pool.query(
      `select upper(context->>'country') as country,
              context->>'region' as region,
              count(distinct anonymous_id)::int as visitors,
              count(*)::int as pageviews
         from public.analytics_events
        where name = '$pageview'
          and ts >= $1 and ts < $2 ${extra}
          and coalesce(context->>'country', '') <> ''
          and coalesce(context->>'region', '') <> ''
        group by 1, 2
        order by visitors desc, pageviews desc
        limit 200`,
      params,
    ),
    pool.query(
      `select count(*)::int as total,
              count(*) filter (where coalesce(context->>'country', '') <> '')::int as located
         from public.analytics_events
        where name = '$pageview' and ts >= $1 and ts < $2 ${extra}`,
      params,
    ),
  ]);

  const totals = coverage.rows[0] || { total: 0, located: 0 };
  return {
    from,
    to,
    app,
    coverage: {
      pageviews: Number(totals.total || 0),
      locatedPageviews: Number(totals.located || 0),
      rate: Number(totals.total || 0) ? Number(totals.located || 0) / Number(totals.total || 1) : 0,
    },
    countries: countries.rows.map((row) => ({
      country: row.country,
      visitors: Number(row.visitors || 0),
      sessions: Number(row.sessions || 0),
      pageviews: Number(row.pageviews || 0),
    })),
    regions: regions.rows.map((row) => ({
      country: row.country,
      region: row.region,
      visitors: Number(row.visitors || 0),
      pageviews: Number(row.pageviews || 0),
    })),
  };
}
