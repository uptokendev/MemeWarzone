import { Pool } from "pg";
import { emitNotification } from "./notifications.js";
import { normalizeChain } from "./notificationContract.js";

const MILESTONES = [75, 85, 95, 99];

function nativeGraduationTarget(chainId: number): number {
  if (chainId === 101 || chainId === 102) return 85;
  return 50;
}

function campaignKey(chainId: number, campaign: string): string {
  const raw = String(campaign || "").trim();
  return normalizeChain(chainId) === "solana" ? raw : raw.toLowerCase();
}

export async function checkMilestones(db: Pool, chainId: number, campaign: string) {
  try {
    const chain = normalizeChain(chainId);
    if (!chain) return;
    const address = campaignKey(chainId, campaign);

    const sumRes = await db.query(
      `select sum(case when side = 'buy' then bnb_amount else -bnb_amount end) as raised
       from public.curve_trades 
       where chain_id = $1 and campaign_address = $2`,
      [chainId, address],
    );
    const raised = Number(sumRes.rows[0]?.raised || 0);
    if (raised <= 0) return;

    const target = nativeGraduationTarget(chainId);
    const progressPct = (raised / target) * 100;

    for (const threshold of MILESTONES) {
      if (progressPct >= threshold) {
        await emitNotification(db, {
          eventType: "campaign.progress_threshold_reached",
          chain,
          chainId,
          dedupKey: `near-grad-alert:${chain}:${address}:${threshold}`,
          markerKey: `near-grad:${chain}:${address}:${threshold}`,
          payload: {
            campaign: address,
            chainId,
            threshold,
            progressPct,
            raisedRaw: raised.toString(),
            reachedAt: new Date().toISOString(),
          },
        });
      }
    }
  } catch (err) {
    console.error("[milestones] Error checking milestones:", err);
  }
}
