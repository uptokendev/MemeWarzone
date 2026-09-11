import { pool } from "../db.js";
import { emitNotification } from "../notifications.js";
import { digestWindow, NOTIFICATION_CHAIN_GROUPS } from "../campaignLifecycleNotifications.js";

async function main() {
  console.log("[generateLeagueStandings] Starting...");
  try {
    const window = digestWindow();
    const epoch = window.slice(0, 10);

    for (const group of NOTIFICATION_CHAIN_GROUPS) {
      const res = await pool.query(
        `select address, current_rank, rank_points
           from public.user_rank_state
          where chain_id = any($1::int[])
          order by current_rank asc nulls last
          limit 10`,
        [group.ids],
      );
      if (!res.rows.length) continue;
      await emitNotification(pool, {
        eventType: "league.weekly_standings_ready",
        chain: group.label,
        dedupKey: `league-weekly-standings:${group.label}:${epoch}:${window}`,
        payload: {
          leagueId: `weekly:${group.label}`,
          leagueType: "weekly",
          epoch,
          updateType: "scheduled",
          standings: res.rows.map((r) => ({
            recipient: r.address,
            score: r.rank_points,
            rank: r.current_rank,
          })),
        },
      });
    }

    console.log("[generateLeagueStandings] Done.");
    process.exit(0);
  } catch (err) {
    console.error("[generateLeagueStandings] Error:", err);
    process.exit(1);
  }
}

main();
