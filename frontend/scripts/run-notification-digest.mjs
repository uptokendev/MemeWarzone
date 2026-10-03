/**
 * CO-5 hourly email digest (Coolify scheduled task on the API service, e.g. "5 * * * *"):
 *   npm run cron:notification-digest
 * One email per wallet with a verified address, listing its new social, reward and coin
 * notifications for the categories whose email is on, with a per-category stop link.
 * Battle emails are not part of it: they are sent immediately.
 */
import "../api/load-local-env.mjs";
import { pool } from "../server/db.js";
import { runNotificationDigest } from "../api/lib/notificationProducers.js";

runNotificationDigest(pool)
  .then((summary) => console.log("[notification-digest]", JSON.stringify(summary)))
  .catch((error) => {
    console.error("[notification-digest]", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
