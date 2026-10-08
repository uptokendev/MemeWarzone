/**
 * CO-5 notification scan (Coolify scheduled task on the API service, every 5 minutes):
 *   npm run cron:notification-scan [-- --rewards-only | --coins-only]
 * Writes bell rows for rewards that became claimable, for coin events (launch, graduation,
 * large buy) and the daily Major War League check-in reminder. Read-only on every source table; idempotent through dedupe keys.
 */
import "../api/load-local-env.mjs";
import { pool } from "../server/db.js";
import { scanCheckinReminders, scanCoinNotifications, scanRewardNotifications } from "../api/lib/notificationProducers.js";

async function main() {
  const coinsOnly = process.argv.includes("--coins-only");
  const rewardsOnly = process.argv.includes("--rewards-only");
  const summary = {};
  if (!coinsOnly) summary.rewards = await scanRewardNotifications(pool);
  if (!rewardsOnly) summary.coins = await scanCoinNotifications(pool);
  // Major War League daily check-in reminder (2026-10-08): one bell row per owner per UTC day.
  if (!coinsOnly && !rewardsOnly) summary.checkin = await scanCheckinReminders(pool);
  console.log("[notification-scan]", JSON.stringify(summary));
}

main()
  .catch((error) => {
    console.error("[notification-scan]", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
