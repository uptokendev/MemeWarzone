import { Pool } from "pg";
import { emitNotification } from "./notifications.js";
import { normalizeChain } from "./notificationContract.js";
import type { MilestoneProgressFor } from "./evm/evmMilestoneProgress.js";

const MILESTONES = [75, 85, 95, 99];

/** Solana only. EVM campaigns use their own graduation rule through `progressFor` (evm/evmMilestoneProgress.ts). */
function solanaNativeGraduationTarget(): number {
  return 85;
}

function isSolanaChainId(chainId: number): boolean {
  return chainId === 101 || chainId === 102;
}

function campaignKey(chainId: number, campaign: string): string {
  const raw = String(campaign || "").trim();
  return normalizeChain(chainId) === "solana" ? raw : raw.toLowerCase();
}

/**
 * `progressFor` is required for EVM chains; without it (or when it returns null, e.g. a failed RPC read)
 * no EVM alert is sent. Solana keeps raised / 85.
 */
export async function checkMilestones(
  db: Pick<Pool, "query">,
  chainId: number,
  campaign: string,
  progressFor?: MilestoneProgressFor,
) {
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

    let progressPct: number;
    if (isSolanaChainId(chainId)) {
      progressPct = (raised / solanaNativeGraduationTarget()) * 100;
    } else {
      const progress = progressFor ? await progressFor(chainId, address) : null;
      if (!progress) return;
      progressPct = progress.progressPct;
    }

    for (const threshold of MILESTONES) {
      if (progressPct >= threshold) {
        await emitNotification(db as Pool, {
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
