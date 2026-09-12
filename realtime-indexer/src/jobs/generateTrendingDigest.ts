import { pool } from "../db.js";
import { emitNotification } from "../notifications.js";
import { digestWindow, NOTIFICATION_CHAIN_GROUPS } from "../campaignLifecycleNotifications.js";

async function main() {
  console.log("[generateTrendingDigest] Starting...");
  try {
    const window = digestWindow();
    for (const group of NOTIFICATION_CHAIN_GROUPS) {
      const res = await pool.query(
        `select chain_id, campaign_address, name, symbol, marketcap_bnb
           from public.campaigns c
           left join public.token_stats ts on ts.chain_id = c.chain_id and ts.campaign_address = c.campaign_address
          where c.chain_id = any($1::int[])
            and c.is_active = true
          order by coalesce(ts.marketcap_bnb, 0) desc
          limit 10`,
        [group.ids],
      );
      if (!res.rows.length) continue;
      await emitNotification(pool, {
        eventType: "campaign.trending_digest_ready",
        chain: group.label,
        dedupKey: `trending-digest:${group.label}:${window}`,
        payload: {
          window,
          sections: [
            {
              id: "trending",
              items: res.rows.map((c) => ({
                campaign: c.campaign_address,
                name: c.name,
                ticker: c.symbol,
                marketcap: c.marketcap_bnb,
              })),
            },
          ],
        },
      });
    }

    console.log("[generateTrendingDigest] Done.");
    process.exit(0);
  } catch (err) {
    console.error("[generateTrendingDigest] Error:", err);
    process.exit(1);
  }
}

main();
