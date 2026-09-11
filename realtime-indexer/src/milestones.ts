import { Pool } from "pg";
import { emitNotification } from "./notifications.js";

const MILESTONES = [75, 85, 95, 99];

export async function checkMilestones(db: Pool, chainId: number, campaign: string) {
  try {
    const sumRes = await db.query(
      `select sum(case when side = 'buy' then bnb_amount else -bnb_amount end) as raised
       from public.curve_trades 
       where chain_id = $1 and campaign_address = $2`,
      [chainId, campaign]
    );
    const raised = Number(sumRes.rows[0]?.raised || 0);
    if (raised <= 0) return;

    // Default targets: 50 for BNB (chains 56, 97), ~85 for Solana (chains 101, 102)
    const target = (chainId === 101 || chainId === 102) ? 85 : 50;
    const progressPct = (raised / target) * 100;

    for (const threshold of MILESTONES) {
      if (progressPct >= threshold) {
        const markerKey = `milestone:${chainId}:${campaign}:${threshold}`;
        await emitNotification(db, {
          eventType: "campaign.progress_threshold_reached",
          chain: "",
          chainId,
          dedupKey: markerKey,
          markerKey: markerKey,
          payload: {
            campaign,
            chainId,
            threshold,
            progressPct,
            raisedRaw: raised.toString(),
            reachedAt: new Date().toISOString()
          }
        });
      }
    }
  } catch (err) {
    console.error("[milestones] Error checking milestones:", err);
  }
}
