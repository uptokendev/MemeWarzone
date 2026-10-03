/**
 * CO-5 notification scan (Coolify scheduled task on the API service, every 5 minutes):
 *   npm run cron:notification-scan [-- --rewards-only | --coins-only]
 * Writes bell rows for rewards that became claimable and for coin events (launch, graduation,
 * large buy). Read-only on every source table; idempotent through dedupe keys.
 */
import "../api/load-local-env.mjs";
import { pool } from "../server/db.js";
import { scanCoinNotifications, scanRewardNotifications } from "../api/lib/notificationProducers.js";

async function main() {
  const coinsOnly = process.argv.includes("--coins-only");
  const rewardsOnly = process.argv.includes("--rewards-only");
  const summary = {};
  if (!coinsOnly) summary.rewards = await scanRewardNotifications(pool);
  if (!rewardsOnly) summary.coins = await scanCoinNotifications(pool);
  console.log("[notification-scan]", JSON.stringify(summary));
}

main()
  .catch((error) => {
    console.error("[notification-scan]", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end().catch(() => undefined));
