// Analytics rollups against a throwaway Postgres: the rollup answers must equal the raw-query answers
// (the SQL the admin routes ran before the rollups) for 24h / 7d / 30d windows that start and end
// mid-hour, for public / admin / both, before and after the job ran, with partial coverage, after a
// late event, after web vital retention, and on an empty schema. Events go in through the real ingest
// persistEvent, including a retried (duplicate) delivery.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const PG_BIN = process.env.ANALYTICS_TEST_PG_BIN
  || ["/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin", "/usr/lib/postgresql/14/bin"].find((dir) => fs.existsSync(path.join(dir, "initdb")));
const PORT = Number(process.env.ANALYTICS_TEST_PG_PORT || 55491);
const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(here, "../../sql/analytics_schema.sql"), "utf8");
const MIGRATION = fs.readFileSync(path.join(here, "../../../db/migrations/20261008_000010_analytics_rollups.sql"), "utf8");
const RETENTION = fs.readFileSync(path.join(here, "../../../database/prod_analytics_web_vital_retention.sql"), "utf8");

const skip = PG_BIN ? false : "no local Postgres binaries (set ANALYTICS_TEST_PG_BIN)";

function run(bin, args) {
  const result = spawnSync(path.join(PG_BIN, bin), args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${bin} failed: ${result.stderr || result.stdout}`);
}

let dir;
let db;
let rollups;
let persistEvent;

// Fixed "now": mid-hour, so every window has partial first and last hours.
const NOW = Date.parse("2026-10-08T10:37:12.345Z");
const HOUR = 3600e3;
const DAY = 24 * HOUR;

test.before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mwz-an-"));
  run("initdb", ["-D", dir, "--auth=trust", "-U", "postgres", "--no-instructions"]);
  run("pg_ctl", ["-D", dir, "-l", path.join(dir, "pg.log"), "-o", `-p ${PORT} -k ${dir} -c listen_addresses=127.0.0.1 -c TimeZone=UTC`, "-w", "start"]);
  const url = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
  process.env.DATABASE_URL = url;
  process.env.PG_DISABLE_SSL = "1";
  db = new pg.Pool({ connectionString: url, max: 8 });
  await db.query("create role anon; create role authenticated; create role service_role;");
  rollups = await import("./rollups.js");
  ({ persistEvent } = await import("./ingest.js"));
});

test.after(async () => {
  if (skip) return;
  const { pool } = await import("../../server/db.js").catch(() => ({}));
  await pool?.end?.().catch(() => {});
  await db?.end().catch(() => {});
  spawnSync(path.join(PG_BIN, "pg_ctl"), ["-D", dir, "-m", "immediate", "stop"], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ----- the raw reference queries (verbatim from the routes before the rollups) -----

function appFilter(app, params) {
  if (app === "public" || app === "admin") {
    params.push(app);
    return `and app = $${params.length}`;
  }
  return "";
}

async function rawReference(from, to, app) {
  const params = [from, to];
  const extra = appFilter(app, params);
  const [dau, series, topEvents, events, vitals] = await Promise.all([
    db.query(`select count(distinct anonymous_id)::int as n from public.analytics_events where ts >= $1 and ts < $2 ${extra}`, params),
    db.query(
      `select date_trunc('hour', ts) as bucket,
              count(*) filter (where name = '$pageview')::int as pageviews,
              count(distinct session_id)::int as sessions
         from public.analytics_events
        where ts >= $1 and ts < $2 ${extra}
        group by 1 order by 1`,
      params,
    ),
    db.query(
      `select name, count(*)::int as count from public.analytics_events
        where ts >= $1 and ts < $2 ${extra} and name not in ('$heartbeat')
        group by name order by count desc, name limit 10`,
      params,
    ),
    db.query(
      `select name, count(*)::int as count from public.analytics_events
        where ts >= $1 and ts < $2 ${extra}
        group by name order by count desc, name limit 200`,
      params,
    ),
    db.query(
      `select properties->>'metric' as metric,
              count(*)::int as n,
              count(*) filter (where coalesce(nullif(properties->>'measurement',''), nullif(properties->>'value','')) is not null)::int as measured_n,
              count(*) filter (where lower(coalesce(properties->>'rating','')) = 'good')::int as good_n,
              count(*) filter (where lower(coalesce(properties->>'rating','')) in ('needs-improvement','needs_improvement','needs improvement'))::int as needs_improvement_n,
              count(*) filter (where lower(coalesce(properties->>'rating','')) = 'poor')::int as poor_n,
              percentile_cont(0.5) within group (order by (coalesce(nullif(properties->>'measurement',''), nullif(properties->>'value','')))::double precision) filter (where coalesce(nullif(properties->>'measurement',''), nullif(properties->>'value','')) is not null) as p50,
              percentile_cont(0.75) within group (order by (coalesce(nullif(properties->>'measurement',''), nullif(properties->>'value','')))::double precision) filter (where coalesce(nullif(properties->>'measurement',''), nullif(properties->>'value','')) is not null) as p75,
              percentile_cont(0.95) within group (order by (coalesce(nullif(properties->>'measurement',''), nullif(properties->>'value','')))::double precision) filter (where coalesce(nullif(properties->>'measurement',''), nullif(properties->>'value','')) is not null) as p95
         from public.analytics_events
        where name = '$web_vital' and ts >= $1 and ts < $2 ${extra}
          and coalesce(properties->>'metric', '') <> ''
        group by 1 order by metric`,
      params,
    ),
  ]);
  return {
    dau: dau.rows[0]?.n || 0,
    series: series.rows.map((row) => ({ bucket: new Date(row.bucket).toISOString(), pageviews: row.pageviews, sessions: row.sessions })),
    topEvents: topEvents.rows,
    events: events.rows,
    vitals: vitals.rows.map((row) => ({
      metric: row.metric,
      n: row.n,
      measuredN: row.measured_n,
      goodN: row.good_n,
      needsImprovementN: row.needs_improvement_n,
      poorN: row.poor_n,
      p50: row.p50 == null ? null : Number(row.p50),
      p75: row.p75 == null ? null : Number(row.p75),
      p95: row.p95 == null ? null : Number(row.p95),
    })),
  };
}

async function rollupAnswer(from, to, app) {
  const coverage = await rollups.readRollupCoverage(db);
  const [dau, series, topEvents, events, vitals] = await Promise.all([
    rollups.distinctVisitors(db, { from, to, app, coverage }),
    rollups.hourlySeries(db, { from, to, app, coverage }),
    rollups.eventCounts(db, { from, to, app, limit: 10, excludeNames: ["$heartbeat"] }),
    rollups.eventCounts(db, { from, to, app, limit: 200 }),
    rollups.vitalStats(db, { from, to, app, coverage }),
  ]);
  return { dau, series, topEvents, events, vitals };
}

function assertClose(actual, expected, label) {
  if (expected == null || actual == null) return assert.equal(actual, expected, label);
  const tolerance = 1e-9 * Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
}

const WINDOWS = { "24h": 1, "7d": 7, "30d": 30 };
const APPS = ["public", "admin", "both"];

async function assertMatchesRaw(label, { to = NOW, windows = WINDOWS } = {}) {
  for (const [windowName, days] of Object.entries(windows)) {
    const from = new Date(to - days * DAY).toISOString();
    const toIso = new Date(to).toISOString();
    for (const app of APPS) {
      const tag = `${label} ${windowName} ${app}`;
      const [raw, rolled] = await Promise.all([rawReference(from, toIso, app), rollupAnswer(from, toIso, app)]);
      assert.equal(rolled.dau, raw.dau, `${tag} dau`);
      assert.deepEqual(rolled.series, raw.series, `${tag} series`);
      assert.deepEqual(rolled.topEvents, raw.topEvents, `${tag} topEvents`);
      assert.deepEqual(rolled.events, raw.events, `${tag} events`);
      assert.equal(rolled.vitals.length, raw.vitals.length, `${tag} vitals length`);
      raw.vitals.forEach((expected, index) => {
        const actual = rolled.vitals[index];
        for (const key of ["metric", "n", "measuredN", "goodN", "needsImprovementN", "poorN"]) {
          assert.equal(actual[key], expected[key], `${tag} vitals ${expected.metric} ${key}`);
        }
        for (const key of ["p50", "p75", "p95"]) assertClose(actual[key], expected[key], `${tag} vitals ${expected.metric} ${key}`);
      });
    }
  }
}

// ----- fixtures -----

let seed = 42;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function pick(list) {
  return list[Math.floor(rand() * list.length)];
}
function uuid() {
  const bytes = Array.from({ length: 16 }, () => Math.floor(rand() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const visitors = { public: Array.from({ length: 40 }, uuid), admin: Array.from({ length: 6 }, uuid) };
const PATHS = ["/", "/token/:address", "/arena", "/league", "/create"];

function makeEvent(ts, app, overrides = {}) {
  const anonymousId = overrides.anonymous_id || pick(visitors[app]);
  const name = overrides.name || pick(["$pageview", "$pageview", "$heartbeat", "$web_vital", "$web_vital", "$web_vital", "buy_submitted", "$identify"]);
  let properties = {};
  if (name === "$web_vital") {
    const metric = pick(["LCP", "CLS", "INP", "TTFB"]);
    const measured = rand() > 0.15;
    const value = metric === "CLS" ? Math.round(rand() * 400) / 1000 : Math.round(rand() * 60) * 8;
    properties = { metric, rating: pick(["good", "needs-improvement", "poor", "Good", ""]), ...(measured ? { measurement: value } : {}) };
  }
  return {
    event_id: crypto.randomUUID(),
    ts: new Date(ts).toISOString(),
    name,
    app,
    anonymous_id: anonymousId,
    session_id: overrides.session_id || uuid(),
    user_id: null,
    path_raw: "/",
    path_template: pick(PATHS),
    properties: { ...properties, ...(overrides.properties || {}) },
    context: {},
    ...overrides,
  };
}

async function ingest(events) {
  const client = await db.connect();
  try {
    await client.query("begin");
    for (const event of events) await persistEvent(client, event);
    await client.query("commit");
  } finally {
    client.release();
  }
}

function fixtureEvents() {
  const events = [];
  // 35 days of history, uneven per hour, both apps, sessions spanning hour boundaries.
  for (let t = NOW - 35 * DAY; t < NOW; t += 7 * 60 * 1000 + Math.floor(rand() * 5 * 60 * 1000)) {
    const app = rand() < 0.85 ? "public" : "admin";
    const sessionId = uuid();
    const anonymousId = pick(visitors[app]);
    const burst = 1 + Math.floor(rand() * 4);
    for (let i = 0; i < burst; i += 1) {
      events.push(makeEvent(t + i * 47_000, app, { session_id: sessionId, anonymous_id: anonymousId }));
    }
  }
  // Exactly on the window edges and on hour boundaries.
  events.push(makeEvent(NOW - DAY, "public", { name: "$pageview" }));
  events.push(makeEvent(NOW - 7 * DAY, "admin", { name: "$pageview" }));
  events.push(makeEvent(Math.floor(NOW / HOUR) * HOUR, "public", { name: "$web_vital", properties: { metric: "LCP", rating: "good", measurement: 1234.5 } }));
  events.push(makeEvent(NOW - 1, "public", { name: "$pageview" }));
  return events;
}

// ----- tests -----

test("empty schema: rollups and raw both answer zero", { skip }, async () => {
  await db.query(SCHEMA);
  assert.equal(await rollups.readRollupCoverage(db), null);
  await assertMatchesRaw("empty");
  const summary = await rollups.buildHourlyRollups({ db, startMs: NOW - 2 * DAY, endMs: NOW, nowMs: NOW });
  assert.equal(summary.chunks, 2);
  await assertMatchesRaw("empty after job");
  await db.query("truncate public.analytics_rollup_state");
});

test("rollup answers equal the raw answers (before the job, partial coverage, full backfill)", { skip }, async () => {
  const events = fixtureEvents();
  await ingest(events);
  // A retried delivery of the same batch: no row, and with the guard no double count either.
  await ingest(events.slice(0, 25));
  const raw = await db.query("select count(*)::int as n from public.analytics_events");
  assert.equal(raw.rows[0].n, events.length);
  const hourly = await db.query("select sum(count)::int as n from public.analytics_hourly_events");
  assert.equal(hourly.rows[0].n, events.length, "hourly counters ignore the duplicate delivery");

  await assertMatchesRaw("before job (all raw)");

  // The cron's default run: trailing 8 days only. Older hours stay raw.
  const cron = await rollups.plannedRange(db, { nowMs: NOW });
  assert.equal(cron.endMs, Math.floor((NOW - rollups.ROLLUP_SETTLE_MS) / HOUR) * HOUR);
  await rollups.buildHourlyRollups({ db, startMs: cron.startMs, endMs: cron.endMs, nowMs: NOW });
  const coverage = await rollups.readRollupCoverage(db);
  assert.equal(coverage.until, cron.endMs);
  await assertMatchesRaw("trailing coverage");

  // Backfill: whole history.
  const backfill = await rollups.plannedRange(db, { nowMs: NOW, backfill: true });
  await rollups.buildHourlyRollups({ db, startMs: backfill.startMs, endMs: backfill.endMs, nowMs: NOW, rebuildHourlyEvents: true });
  const full = await rollups.readRollupCoverage(db);
  assert.equal(full.from, backfill.startMs);
  await assertMatchesRaw("full coverage");

  // Windows ending in the past (covered tail) and the job run twice: still equal.
  await rollups.buildHourlyRollups({ db, startMs: cron.startMs, endMs: cron.endMs, nowMs: NOW });
  await assertMatchesRaw("past window", { to: NOW - 3 * DAY - 17 * 60 * 1000 });
});

test("a late event shows after the next job run; a stale coverage only costs speed", { skip }, async () => {
  const lateTs = NOW - 2 * DAY - 13 * 60 * 1000;
  await ingest([makeEvent(lateTs, "public", { name: "$pageview", anonymous_id: uuid() })]);
  const from = new Date(NOW - 7 * DAY).toISOString();
  const to = new Date(NOW).toISOString();
  const raw = await rawReference(from, to, "public");
  const coverage = await rollups.readRollupCoverage(db);
  const before = await rollups.distinctVisitors(db, { from, to, app: "public", coverage });
  assert.equal(before, raw.dau - 1, "a brand-new visitor in an already built hour waits for the next run");
  const next = await rollups.plannedRange(db, { nowMs: NOW });
  await rollups.buildHourlyRollups({ db, startMs: next.startMs, endMs: next.endMs, nowMs: NOW });
  await assertMatchesRaw("after late event");
});

test("backfill rebuild removes the old double counts from analytics_hourly_events", { skip }, async () => {
  // Simulate the pre-guard double count of a retried delivery in an old hour.
  const { rows } = await db.query(
    `update public.analytics_hourly_events set count = count + 3
      where bucket = (select max(bucket) from public.analytics_hourly_events
                       where name = '$pageview' and app = 'public' and bucket < now() - interval '9 days')
        and name = '$pageview' and app = 'public'
      returning bucket`,
  );
  assert.equal(rows.length, 1);
  await assert.rejects(assertMatchesRaw("inflated"));
  const backfill = await rollups.plannedRange(db, { nowMs: NOW, backfill: true });
  await rollups.buildHourlyRollups({ db, startMs: backfill.startMs, endMs: backfill.endMs, nowMs: NOW, rebuildHourlyEvents: true });
  await assertMatchesRaw("rebuilt");
});

test("retention SQL deletes only frozen covered hours and the dashboard numbers do not change", { skip }, async () => {
  // Hour-aligned start: a window's raw first partial hour older than 14 days loses its deleted
  // $web_vital rows (documented); whole hours come from the rollups and must not change.
  const from = new Date(Math.ceil((NOW - 30 * DAY) / HOUR) * HOUR).toISOString();
  const to = new Date(NOW).toISOString();
  const beforeAnswer = await rollupAnswer(from, to, "both");

  const deleteStep = RETENTION.split("-- Step B.")[1].split("-- Step C.")[0];
  const statement = deleteStep.slice(deleteStep.indexOf("with doomed"));
  // date_trunc('day', now()) in the file; pin it to the fixture clock.
  const pinned = statement.replaceAll("now()", `'${new Date(NOW).toISOString()}'::timestamptz`);
  let deleted = 0;
  for (;;) {
    const result = await db.query(pinned);
    deleted += result.rowCount;
    if (result.rowCount === 0) break;
  }
  assert.ok(deleted > 0, "old web vitals deleted");
  const left = await db.query(
    `select min(ts) as oldest from public.analytics_events where name = '$web_vital'`,
  );
  assert.ok(new Date(left.rows[0].oldest).getTime() >= Math.floor((NOW - 14 * DAY) / DAY) * DAY);

  // Re-running the backfill after retention must not shrink the frozen web vital rollups.
  const backfill = await rollups.plannedRange(db, { nowMs: NOW, backfill: true });
  await rollups.buildHourlyRollups({ db, startMs: backfill.startMs, endMs: backfill.endMs, nowMs: NOW, rebuildHourlyEvents: true });
  const afterAnswer = await rollupAnswer(from, to, "both");
  assert.deepEqual(afterAnswer.vitals, beforeAnswer.vitals);
  assert.deepEqual(afterAnswer.events, beforeAnswer.events);
  assert.equal(afterAnswer.dau, beforeAnswer.dau);
});

test("retention SQL deletes nothing when the rollup state is missing", { skip }, async () => {
  await db.query("truncate public.analytics_rollup_state");
  const statement = RETENTION.split("-- Step B.")[1].split("-- Step C.")[0];
  const result = await db.query(statement.slice(statement.indexOf("with doomed")));
  assert.equal(result.rowCount, 0);
});

test("migration file is idempotent and keeps the RLS model", { skip }, async () => {
  await db.query(MIGRATION);
  await db.query(MIGRATION);
  await db.query(SCHEMA);
  const { rows } = await db.query(
    `select c.relname, c.relrowsecurity,
            has_table_privilege('service_role', c.oid, 'select') as service_select,
            has_table_privilege('anon', c.oid, 'select') as anon_select
       from pg_class c
      where c.relname in ('analytics_hourly_visitors','analytics_hourly_sessions','analytics_hourly_vital_values','analytics_rollup_state')
      order by 1`,
  );
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname} RLS`);
    assert.equal(row.service_select, false, `${row.relname} service_role`);
    assert.equal(row.anon_select, false, `${row.relname} anon`);
  }
});

test("rollup tables missing (migration not applied yet): reads fall back to raw", { skip }, async () => {
  await db.query(`drop table public.analytics_hourly_visitors, public.analytics_hourly_sessions,
                  public.analytics_hourly_vital_values, public.analytics_rollup_state`);
  assert.equal(await rollups.readRollupCoverage(db), null);
  // 24h and 7d only: the retention test above removed raw web vitals older than 14 days, which
  // analytics_hourly_events still counts (by design).
  await assertMatchesRaw("no rollup tables", { windows: { "24h": 1, "7d": 7 } });
});
