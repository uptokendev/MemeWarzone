/**
 * Analytics retention (Coolify scheduled task on the API service, weekly, "37 3 * * 1"):
 *   npm run cron:analytics-retention
 * Deletes raw $web_vital events older than 14 days in hours the rollup job has already built, in
 * batches of 50,000 (api/analytics/rollups.js deleteOldWebVitals). The hourly rollups keep the
 * dashboard numbers. Postgres autovacuum makes the freed space reusable; a VACUUM FULL to shrink the
 * file on disk stays a manual step because it locks the table.
 * Option: --days N (minimum 9, default 14).
 */
import "../api/load-local-env.mjs";
import { pool } from "../server/db.js";
import { deleteOldWebVitals, WEB_VITAL_RETENTION_DAYS } from "../api/analytics/rollups.js";

const index = process.argv.indexOf("--days");
const days = index > -1 ? Number(process.argv[index + 1]) : WEB_VITAL_RETENTION_DAYS;

async function main() {
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number");
  const started = Date.now();
  const result = await deleteOldWebVitals(pool, { retentionDays: days });
  console.log("[analytics-retention]", JSON.stringify({ ...result, ms: Date.now() - started }));
}

main()
  .catch((error) => {
    console.error("[analytics-retention]", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
