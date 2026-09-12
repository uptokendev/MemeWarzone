import { pool } from "../db.js";
import { emitNotification } from "../notifications.js";
import { digestWindow, NOTIFICATION_CHAIN_GROUPS } from "../campaignLifecycleNotifications.js";

async function main() {
  console.log("[generatePlatformBriefs] Starting...");
  try {
    const window = digestWindow();
    for (const group of NOTIFICATION_CHAIN_GROUPS) {
      await emitNotification(pool, {
        eventType: "platform.daily_brief_ready",
        chain: group.label,
        dedupKey: `daily-war-brief:${group.label}:${window.slice(0, 10)}`,
        payload: { date: window.slice(0, 10), window },
      });
    }

    console.log("[generatePlatformBriefs] Done.");
    process.exit(0);
  } catch (err) {
    console.error("[generatePlatformBriefs] Error:", err);
    process.exit(1);
  }
}

main();
