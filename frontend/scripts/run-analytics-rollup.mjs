/**
 * Analytics rollups (Coolify scheduled task on the API service, hourly, "7 * * * *"):
 *   npm run cron:analytics-rollup
 * Builds analytics_hourly_visitors / analytics_hourly_sessions / analytics_hourly_vital_values for the
 * finished hours of the last 8 days (late deliveries included) and extends analytics_rollup_state.
 * The admin analytics routes read these for covered hours and raw events for the rest.
 *
 * One-off backfill of the whole history (run once after the migration, before the web vital retention SQL):
 *   npm run cron:analytics-rollup -- --backfill
 * --backfill also rebuilds analytics_hourly_events from the raw rows, removing the double counts of
 * retried deliveries that ingest made before the duplicate guard.
 * Other options: --days N (trailing window, default 8), --since <ISO> (explicit start).
 * Reads analytics_events, writes only the rollup tables. Idempotent.
 */
import "../api/load-local-env.mjs";
import { pool } from "../server/db.js";
import { buildHourlyRollups, plannedRange, ROLLUP_TRAILING_DAYS } from "../api/analytics/rollups.js";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index > -1 ? process.argv[index + 1] : null;
}

const backfill = process.argv.includes("--backfill");
const days = Number(argValue("--days") || ROLLUP_TRAILING_DAYS);
const since = argValue("--since");

async function main() {
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
  if (since && Number.isNaN(new Date(since).getTime())) throw new Error("--since must be an ISO timestamp");
  const { startMs, endMs } = await plannedRange(pool, { days, backfill, since });
  const started = Date.now();
  const summary = await buildHourlyRollups({
    db: pool,
    startMs,
    endMs,
    rebuildHourlyEvents: backfill,
    log: backfill ? (row) => console.log("[analytics-rollup]", JSON.stringify(row)) : () => {},
  });
  console.log("[analytics-rollup]", JSON.stringify({ ...summary, backfill, ms: Date.now() - started }));
}

main()
  .catch((error) => {
    console.error("[analytics-rollup]", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
