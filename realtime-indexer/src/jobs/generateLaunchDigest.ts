import { pool } from "../db.js";
import { emitNotification } from "../notifications.js";
import { digestWindow, NOTIFICATION_CHAIN_GROUPS } from "../campaignLifecycleNotifications.js";

async function main() {
  console.log("[generateLaunchDigest] Starting...");
  try {
    const window = digestWindow();
    const res = await pool.query(`
      select chain_id, campaign_address, name, symbol 
      from public.campaigns 
      where created_at >= now() - interval '4 hours'
      order by created_at desc
      limit 60
    `);

    if (res.rows.length === 0) {
      console.log("[generateLaunchDigest] No new campaigns. Exiting.");
      process.exit(0);
    }

    for (const group of NOTIFICATION_CHAIN_GROUPS) {
      const launches = res.rows.filter((row) => group.ids.includes(Number(row.chain_id)));
      if (!launches.length) continue;
      await emitNotification(pool, {
        eventType: "campaign.launch_digest_ready",
        chain: group.label,
        dedupKey: `new-launch-digest:${group.label}:${window}`,
        payload: {
          window,
          totalCount: launches.length,
          launches: launches.map((c) => ({
            campaign: c.campaign_address,
            name: c.name,
            ticker: c.symbol,
          })),
        },
      });
    }

    console.log("[generateLaunchDigest] Done.");
    process.exit(0);
  } catch (err) {
    console.error("[generateLaunchDigest] Error:", err);
    process.exit(1);
  }
}

main();
