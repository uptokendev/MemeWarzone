import { pool } from "../db.js";
import { ENV } from "../env.js";
import { emitNotification } from "../notifications.js";
import { ensurePublishedAirdropDrawForEpoch } from "../rewards/airdrops.js";
import { processRewardEligibilityForEpoch } from "../rewards/eligibility.js";
import { getCurrentWeeklyEpoch } from "../rewards/epochs.js";
import { materializeRewardLedgerForEpoch, publishRewardLedgerForEpoch } from "../rewards/ledger.js";

const REQUIRED_PROGRAMS = ["recruiter", "airdrop_trader", "airdrop_creator", "squad"] as const;

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

async function hasCompleteEligibilitySnapshot(epochId: number): Promise<boolean> {
  const result = await pool.query(
    `with per_wallet as (
       select wallet_address, count(distinct program)::int as programs
         from public.eligibility_results
        where epoch_id=$1
          and program = any($2::text[])
        group by wallet_address
     ), summary as (
       select count(*)::int as wallets,
              count(*) filter (where programs=$3)::int as complete_wallets
         from per_wallet
     )
     select wallets, complete_wallets
       from summary`,
    [epochId, [...REQUIRED_PROGRAMS], REQUIRED_PROGRAMS.length],
  );
  const wallets = Number(result.rows[0]?.wallets || 0);
  const completeWallets = Number(result.rows[0]?.complete_wallets || 0);
  return wallets > 0 && wallets === completeWallets;
}

export async function runRewardEpochChain(chainId: number) {
  if (!ENV.DATABASE_URL) throw new Error("DATABASE_URL missing");
  const sha = process.env.SOURCE_COMMIT || process.env.COOLIFY_GIT_COMMIT_SHA || process.env.GIT_SHA || "unset";
  const startedAt = Date.now();
  console.log(`[processRewardEpochBounded] BUILD_SHA=${sha} chainId=${chainId}`);

  await getCurrentWeeklyEpoch(chainId);

  const epochLimit = Math.max(1, Math.min(52, Number(process.env.PROCESS_REWARD_EPOCH_LIMIT || "1") || 1));
  const epochs = await pool.query(
    `select id
       from public.epochs
      where chain_id=$1
        and epoch_type='weekly'
        and end_at <= now()
        and status in ('open','processing','finalized')
      order by start_at desc
      limit $2`,
    [chainId, epochLimit],
  );

  for (const row of epochs.rows) {
    const epochId = Number(row.id);
    const epochStartedAt = Date.now();
    const snapshotComplete = await hasCompleteEligibilitySnapshot(epochId);
    console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=eligibility snapshotComplete=${snapshotComplete}`);

    if (!snapshotComplete) {
      const stageStartedAt = Date.now();
      const eligibility = await processRewardEligibilityForEpoch(epochId);
      console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=eligibility_done wallets=${eligibility.walletCount} results=${eligibility.resultCount} durationMs=${elapsedMs(stageStartedAt)}`);
    } else {
      console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=eligibility_reused`);
    }

    let stageStartedAt = Date.now();
    const traderDraw = await ensurePublishedAirdropDrawForEpoch(epochId, "airdrop_trader");
    console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=trader_draw_done drawId=${traderDraw.draw.id} winners=${traderDraw.winners.length} durationMs=${elapsedMs(stageStartedAt)}`);

    stageStartedAt = Date.now();
    const creatorDraw = await ensurePublishedAirdropDrawForEpoch(epochId, "airdrop_creator");
    console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=creator_draw_done drawId=${creatorDraw.draw.id} winners=${creatorDraw.winners.length} durationMs=${elapsedMs(stageStartedAt)}`);

    stageStartedAt = Date.now();
    const materialized = await materializeRewardLedgerForEpoch(epochId);
    console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=materialize_done rows=${materialized.materializedCount} durationMs=${elapsedMs(stageStartedAt)}`);

    stageStartedAt = Date.now();
    const published = await publishRewardLedgerForEpoch(epochId, new Date());
    console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=publish_done status=${published.epoch.status} claimable=${published.updatedCount} durationMs=${elapsedMs(stageStartedAt)}`);

    if (published.epoch.status === "published") {
      await emitNotification(pool, {
        eventType: "airdrop.claims_open",
        chain: chainId === 101 ? "solana" : "bnb",
        dedupKey: `airdrop-claims-open:${chainId}:${epochId}`,
        payload: {
          chain: chainId === 101 ? "solana" : "bnb",
          epochId,
          claimableCount: published.updatedCount,
        },
      });
    }

    console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=done durationMs=${elapsedMs(epochStartedAt)}`);
  }

  console.log(`[processRewardEpochBounded] chainId=${chainId} processed=${epochs.rows.length} durationMs=${elapsedMs(startedAt)}`);
}
