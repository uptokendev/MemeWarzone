// Read and build paths for the analytics rollups.
//
// Every admin read splits its [from, to) window into three parts:
//   [from, start)  raw analytics_events (at most the partial first hour, or the part the rollup has not built)
//   [start, end)   whole hours from a rollup table
//   [end, to)      raw analytics_events (the current partial hour, plus anything newer than the rollup)
// so the answer is the same as one raw query over [from, to), only cheaper.
//
// Two kinds of rollup:
//   * Ingest-maintained (analytics_hourly_events and friends): incremented per event at ingest, so every
//     finished hour is present. Coverage is "all whole hours".
//   * Job-built (analytics_hourly_visitors, analytics_hourly_sessions, analytics_hourly_vital_values):
//     written by `npm run cron:analytics-rollup` for finished hours. Coverage is the contiguous range in
//     analytics_rollup_state; anything outside it is read raw, so a missing or late job costs speed, not
//     correctness.

export const ROLLUP_STATE_NAME = "hourly_rollups";
// The cron rebuilds this many trailing days on every run. Ingest accepts event timestamps up to 7 days
// old (ingest.js sanitizeEvent), so 8 days catches every late delivery.
export const ROLLUP_TRAILING_DAYS = 8;
// The job never builds the hour that is still filling up; it stops this far behind now.
export const ROLLUP_SETTLE_MS = 5 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const INGEST_COVERAGE = Object.freeze({ from: -Infinity, until: Infinity });

const VALUE_EXPR = `coalesce(nullif(properties->>'measurement',''), nullif(properties->>'value',''))`;

export function floorHour(value) {
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Math.floor(t / HOUR_MS) * HOUR_MS;
}

export function ceilHour(value) {
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Math.ceil(t / HOUR_MS) * HOUR_MS;
}

function toMs(value) {
  if (value === -Infinity || value === Infinity) return value;
  if (value == null) return NaN;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function isMissingSchema(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

/**
 * The part of [from, to) that a rollup answers: whole hours, inside its coverage.
 * Returns ISO strings. When nothing qualifies, start = end = to, so the raw parts are
 * [from, to) and [to, to) (empty) and the rollup part is empty.
 */
export function rollupWindow(from, to, coverage) {
  const fromMs = toMs(from);
  const toMsValue = toMs(to);
  const toIso = new Date(toMsValue).toISOString();
  if (!coverage || !Number.isFinite(fromMs) || !Number.isFinite(toMsValue)) return { start: toIso, end: toIso };
  const covFrom = toMs(coverage.from);
  const covUntil = toMs(coverage.until);
  if (Number.isNaN(covFrom) || Number.isNaN(covUntil)) return { start: toIso, end: toIso };
  const start = Math.max(ceilHour(fromMs), covFrom);
  const end = Math.min(floorHour(toMsValue), covUntil);
  if (!(start < end)) return { start: toIso, end: toIso };
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/** Coverage of the job-built rollups, or null when the table is missing or the job never ran. */
export async function readRollupCoverage(db) {
  try {
    const result = await db.query(
      `select covered_from, covered_until
         from public.analytics_rollup_state
        where name = $1`,
      [ROLLUP_STATE_NAME],
    );
    const row = result.rows[0];
    if (!row?.covered_from || !row?.covered_until) return null;
    return { from: new Date(row.covered_from).getTime(), until: new Date(row.covered_until).getTime() };
  } catch (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
}

function appFilter(app, params) {
  if (app === "public" || app === "admin") {
    params.push(app);
    return `and app = $${params.length}`;
  }
  return "";
}

/**
 * Params and SQL fragments for one read. useRollup is false when no whole covered hour is in the
 * window (or the job never ran); the query then leaves the rollup table out entirely, so it also
 * works before the migration is applied.
 *
 * raw(cols, where) returns the raw part as separate UNION ALL branches, one per edge. (A single
 * `(ts in edge 1) or (ts in edge 2)` predicate made the planner walk the whole anonymous_id index:
 * 20 s instead of 3 s on production.)
 */
function readPlan(from, to, coverage, app) {
  const w = rollupWindow(from, to, coverage);
  const useRollup = w.start < w.end;
  const params = [from, to];
  if (useRollup) params.push(w.start, w.end);
  const extra = appFilter(app, params);
  const rollupHours = useRollup ? `bucket >= $3 and bucket < $4 ${extra}` : null;
  const raw = (cols, where = "") => {
    const cond = where ? `and ${where}` : "";
    if (!useRollup) {
      return `select ${cols} from public.analytics_events where ts >= $1 and ts < $2 ${cond} ${extra}`;
    }
    return `select ${cols} from public.analytics_events where ts >= $1 and ts < $3 ${cond} ${extra}
         union all
         select ${cols} from public.analytics_events where ts >= $4 and ts < $2 ${cond} ${extra}`;
  };
  return { params, extra, useRollup, rollupHours, raw };
}

/** count(distinct anonymous_id) over all events in [from, to). */
export async function distinctVisitors(db, { from, to, app, coverage }) {
  const plan = readPlan(from, to, coverage, app);
  const rolled = plan.useRollup
    ? `select anonymous_id from public.analytics_hourly_visitors where ${plan.rollupHours}
         union all
         `
    : "";
  const result = await db.query(
    `select count(distinct anonymous_id)::int as n
       from (
         ${rolled}${plan.raw("anonymous_id")}
       ) v`,
    plan.params,
  );
  return result.rows[0]?.n || 0;
}

/**
 * Hourly series: one row per hour that has any event, with $pageview count and distinct sessions.
 * Pageviews always come from raw $pageview rows (small, indexed by name), so they are exact.
 * The raw edges and the rollup hours never share a bucket: the edges are the partial first hour
 * (before the first whole hour) and the hours from the end of the coverage on.
 */
export async function hourlySeries(db, { from, to, app, coverage }) {
  const plan = readPlan(from, to, coverage, app);
  const rawEdges = `select date_trunc('hour', ts) as bucket,
            count(*) filter (where name = '$pageview')::int as pageviews,
            count(distinct session_id)::int as sessions
       from (
         ${plan.raw("ts, name, session_id")}
       ) e
      group by 1`;
  const rolled = `select r.bucket, coalesce(v.pageviews, 0)::int as pageviews, r.sessions
       from (
         select bucket, count(distinct session_id)::int as sessions
           from public.analytics_hourly_sessions
          where ${plan.rollupHours}
          group by 1
       ) r
       left join (
         select date_trunc('hour', ts) as bucket, count(*)::int as pageviews
           from public.analytics_events
          where name = '$pageview' and ts >= $3 and ts < $4 ${plan.extra}
          group by 1
       ) v on v.bucket = r.bucket`;
  const result = await db.query(
    plan.useRollup ? `${rawEdges}\n     union all\n     ${rolled}\n     order by 1` : `${rawEdges}\n     order by 1`,
    plan.params,
  );
  return result.rows.map((row) => ({
    bucket: new Date(row.bucket).toISOString(),
    pageviews: row.pageviews,
    sessions: row.sessions,
  }));
}

/** Event counts by name from analytics_hourly_events (whole hours) plus the raw partial hours. */
export async function eventCounts(db, { from, to, app, limit, excludeNames = [] }) {
  const plan = readPlan(from, to, INGEST_COVERAGE, app);
  let exclude = "";
  if (excludeNames.length) {
    plan.params.push(excludeNames);
    exclude = `name <> all($${plan.params.length}::text[])`;
  }
  plan.params.push(limit);
  const limitParam = `$${plan.params.length}`;
  const rolled = plan.useRollup
    ? `select name, count as c
           from public.analytics_hourly_events
          where ${plan.rollupHours} ${exclude ? `and ${exclude}` : ""}
         union all
         `
    : "";
  const result = await db.query(
    `select name, sum(c)::int as count
       from (
         ${rolled}select name, count(*) as c
           from (
             ${plan.raw("name", exclude)}
           ) e
          group by name
       ) x
      group by name
      order by count desc, name
      limit ${limitParam}`,
    plan.params,
  );
  return result.rows.map((row) => ({ name: row.name, count: row.count }));
}

/**
 * Web vital stats per metric: counts, ratings and exact percentile_cont p50/p75/p95.
 * The rollup stores (metric, rating, value, n) per hour; percentiles are computed over the
 * weighted values with the same interpolation Postgres percentile_cont uses.
 * Only rows with a non-empty metric are counted (the tracker always sends one).
 */
export async function vitalStats(db, { from, to, app, coverage }) {
  const plan = readPlan(from, to, coverage, app);
  const rolled = plan.useRollup
    ? `select metric, rating, value, n::bigint as n
         from public.analytics_hourly_vital_values
        where ${plan.rollupHours}
       union all
       `
    : "";
  const rawCols = `properties->>'metric' as metric,
              lower(coalesce(properties->>'rating', '')) as rating,
              (${VALUE_EXPR})::double precision as value,
              1::bigint as n`;
  const result = await db.query(
    `with v as (
       ${rolled}${plan.raw(rawCols, `name = '$web_vital' and coalesce(properties->>'metric', '') <> ''`)}
     ),
     m as (
       select metric,
              sum(n)::int as n,
              coalesce(sum(n) filter (where value is not null), 0)::int as measured_n,
              coalesce(sum(n) filter (where rating = 'good'), 0)::int as good_n,
              coalesce(sum(n) filter (where rating in ('needs-improvement','needs_improvement','needs improvement')), 0)::int as needs_improvement_n,
              coalesce(sum(n) filter (where rating = 'poor'), 0)::int as poor_n
         from v
        group by metric
     ),
     agg as (
       select metric, value, sum(n)::float8 as n
         from v
        where value is not null
        group by metric, value
     ),
     c as (
       select metric, value,
              sum(n) over w - n as lo_idx,
              sum(n) over w as hi_idx,
              sum(n) over (partition by metric) as total
         from agg
       window w as (partition by metric order by value rows between unbounded preceding and current row)
     ),
     q as (
       select t.metric, p.p, p.p * (t.total - 1) as h
         from (select distinct metric, total from c) t
        cross join (values (0.5::float8), (0.75::float8), (0.95::float8)) as p(p)
     ),
     pct as (
       select q.metric, q.p, lo.value + (hi.value - lo.value) * (q.h - floor(q.h)) as val
         from q
         join c lo on lo.metric = q.metric and lo.lo_idx <= floor(q.h) and floor(q.h) < lo.hi_idx
         join c hi on hi.metric = q.metric and hi.lo_idx <= ceil(q.h) and ceil(q.h) < hi.hi_idx
     )
     select m.*,
            (select val from pct where pct.metric = m.metric and pct.p = 0.5) as p50,
            (select val from pct where pct.metric = m.metric and pct.p = 0.75) as p75,
            (select val from pct where pct.metric = m.metric and pct.p = 0.95) as p95
       from m
      order by m.metric`,
    plan.params,
  );
  return result.rows.map((row) => ({
    metric: row.metric,
    n: Number(row.n || 0),
    measuredN: Number(row.measured_n || 0),
    goodN: Number(row.good_n || 0),
    needsImprovementN: Number(row.needs_improvement_n || 0),
    poorN: Number(row.poor_n || 0),
    p50: row.p50 == null ? null : Number(row.p50),
    p75: row.p75 == null ? null : Number(row.p75),
    p95: row.p95 == null ? null : Number(row.p95),
  }));
}

// ---------------------------------------------------------------------------------------------
// Build (cron + backfill)
// ---------------------------------------------------------------------------------------------

function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Hours whose web-vital-derived rows are frozen: already covered and older than the trailing window.
 * The retention SQL only deletes raw $web_vital rows inside this range, so a later rebuild can never
 * replace a rollup row with a count taken after retention removed its source rows.
 */
export function protectedRange(coverage, nowMs, trailingDays = ROLLUP_TRAILING_DAYS) {
  if (!coverage) return { from: 0, until: 0 };
  const trailingFloor = floorHour(nowMs - trailingDays * DAY_MS);
  const until = Math.min(coverage.until, trailingFloor);
  if (!(coverage.from < until)) return { from: 0, until: 0 };
  return { from: coverage.from, until };
}

async function buildChunk(client, { start, end, guard, rebuildHourlyEvents }) {
  const range = [iso(start), iso(end)];
  const guardParams = [iso(guard.from), iso(guard.until)];

  const visitors = await client.query(
    `insert into public.analytics_hourly_visitors (bucket, app, anonymous_id)
     select distinct date_trunc('hour', ts), app, anonymous_id
       from public.analytics_events
      where ts >= $1 and ts < $2
     on conflict do nothing`,
    range,
  );
  const sessions = await client.query(
    `insert into public.analytics_hourly_sessions (bucket, app, session_id)
     select distinct date_trunc('hour', ts), app, session_id
       from public.analytics_events
      where ts >= $1 and ts < $2
     on conflict do nothing`,
    range,
  );

  await client.query(
    `delete from public.analytics_hourly_vital_values
      where bucket >= $1 and bucket < $2
        and not (bucket >= $3 and bucket < $4)`,
    [...range, ...guardParams],
  );
  const vitals = await client.query(
    `insert into public.analytics_hourly_vital_values (bucket, app, metric, rating, value, n)
     select date_trunc('hour', ts),
            app,
            properties->>'metric',
            lower(coalesce(properties->>'rating', '')),
            (${VALUE_EXPR})::double precision,
            count(*)::int
       from public.analytics_events
      where name = '$web_vital'
        and ts >= $1 and ts < $2
        and not (ts >= $3 and ts < $4)
        and coalesce(properties->>'metric', '') <> ''
      group by 1, 2, 3, 4, 5`,
    [...range, ...guardParams],
  );

  let hourlyEvents = null;
  if (rebuildHourlyEvents) {
    // Ingest counted retried deliveries twice (the event insert was skipped, the counter was not).
    // Rebuild from the deduplicated raw rows. $web_vital rows in frozen hours are left alone.
    const upserted = await client.query(
      `insert into public.analytics_hourly_events (bucket, app, name, count)
       select date_trunc('hour', ts), app, name, count(*)::int
         from public.analytics_events
        where ts >= $1 and ts < $2
          and not (name = '$web_vital' and ts >= $3 and ts < $4)
        group by 1, 2, 3
       on conflict (bucket, app, name) do update set count = excluded.count`,
      [...range, ...guardParams],
    );
    const removed = await client.query(
      `delete from public.analytics_hourly_events h
        where h.bucket >= $1 and h.bucket < $2
          and not (h.name = '$web_vital' and h.bucket >= $3 and h.bucket < $4)
          and not exists (
            select 1 from public.analytics_events e
             where e.name = h.name and e.app = h.app
               and e.ts >= h.bucket and e.ts < h.bucket + interval '1 hour'
          )`,
      [...range, ...guardParams],
    );
    hourlyEvents = { upserted: upserted.rowCount, removed: removed.rowCount };
  }

  return {
    visitors: visitors.rowCount,
    sessions: sessions.rowCount,
    vitalRows: vitals.rowCount,
    hourlyEvents,
  };
}

/**
 * Build the job rollups for the finished hours in [startMs, endMs) and extend the coverage.
 * Idempotent: visitor/session sets only grow, vital values are replaced per hour (outside the
 * frozen range). One transaction per day, serialized by an advisory transaction lock, so two
 * overlapping runs cannot interleave a delete and an insert. No session-level state is used
 * (safe on the transaction pooler).
 */
export async function buildHourlyRollups({
  db,
  startMs,
  endMs,
  nowMs = Date.now(),
  rebuildHourlyEvents = false,
  log = () => {},
}) {
  const start = floorHour(startMs);
  const end = floorHour(endMs);
  if (!(start < end)) return { start: iso(start), end: iso(end), chunks: 0, totals: {} };

  const coverageBefore = await readRollupCoverage(db);
  const guard = protectedRange(coverageBefore, nowMs);
  const totals = { visitors: 0, sessions: 0, vitalRows: 0, hourlyEventsUpserted: 0, hourlyEventsRemoved: 0 };
  let chunks = 0;

  for (let chunkStart = start; chunkStart < end; chunkStart += DAY_MS) {
    const chunkEnd = Math.min(chunkStart + DAY_MS, end);
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext('mwz_analytics_rollup'))");
      const result = await buildChunk(client, { start: chunkStart, end: chunkEnd, guard, rebuildHourlyEvents });
      await client.query("commit");
      chunks += 1;
      totals.visitors += result.visitors;
      totals.sessions += result.sessions;
      totals.vitalRows += result.vitalRows;
      if (result.hourlyEvents) {
        totals.hourlyEventsUpserted += result.hourlyEvents.upserted;
        totals.hourlyEventsRemoved += result.hourlyEvents.removed;
      }
      log({ chunk: iso(chunkStart), ...result });
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Extend the coverage. plannedRange always starts at or before covered_until, so the ranges touch;
  // a range that does not touch (never produced by plannedRange) leaves the coverage unchanged rather
  // than replacing it, so frozen hours stay frozen.
  await db.query(
    `insert into public.analytics_rollup_state as s (name, covered_from, covered_until, updated_at)
     values ($1, $2, $3, now())
     on conflict (name) do update set
       covered_from = case
         when s.covered_until >= excluded.covered_from and s.covered_from <= excluded.covered_until
           then least(s.covered_from, excluded.covered_from)
         else s.covered_from end,
       covered_until = case
         when s.covered_until >= excluded.covered_from and s.covered_from <= excluded.covered_until
           then greatest(s.covered_until, excluded.covered_until)
         else s.covered_until end,
       updated_at = now()`,
    [ROLLUP_STATE_NAME, iso(start), iso(end)],
  );

  const coverage = await readRollupCoverage(db);
  return {
    start: iso(start),
    end: iso(end),
    chunks,
    totals,
    coverage: coverage ? { from: iso(coverage.from), until: iso(coverage.until) } : null,
  };
}

/** The range a cron or backfill run builds. */
export async function plannedRange(db, { nowMs = Date.now(), days = ROLLUP_TRAILING_DAYS, backfill = false, since = null }) {
  const endMs = floorHour(nowMs - ROLLUP_SETTLE_MS);
  let startMs;
  if (since) {
    startMs = floorHour(new Date(since).getTime());
  } else if (backfill) {
    const first = await db.query(`select min(ts) as first from public.analytics_events`);
    startMs = first.rows[0]?.first ? floorHour(new Date(first.rows[0].first).getTime()) : endMs;
  } else {
    startMs = floorHour(endMs - days * DAY_MS);
  }
  // Never leave a hole: if the job was down longer than its window, start where the coverage ends,
  // so the covered range stays one contiguous block (the retention SQL relies on it).
  const coverage = await readRollupCoverage(db);
  if (coverage && coverage.until < startMs) startMs = coverage.until;
  return { startMs, endMs };
}
