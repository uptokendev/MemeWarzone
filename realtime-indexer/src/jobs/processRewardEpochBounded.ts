import { pool } from "../db.js";
import { ENV } from "../env.js";
import { emitNotification } from "../notifications.js";
import { ensurePublishedAirdropDrawForEpoch, type AirdropDrawProgram } from "../rewards/airdrops.js";
import { processRewardEligibilityForEpoch } from "../rewards/eligibility.js";
import { getCurrentWeeklyEpoch } from "../rewards/epochs.js";
import { materializeRewardLedgerForEpoch, publishRewardLedgerForEpoch } from "../rewards/ledger.js";
import { ensurePublishedZeroAirdropDrawForEpoch, hasZeroAirdropWork } from "./zeroAirdropDraw.js";
import { finalizeStrictZeroRewardEpoch } from "./finalizeZeroRewardEpoch.js";

const REQUIRED_PROGRAMS = ["recruiter", "airdrop_trader", "airdrop_creator", "squad"] as const;

let currentRewardEpochStage = "idle";

export function getRewardEpochStage(): string {
  return currentRewardEpochStage;
}

function setRewardEpochStage(stage: string): void {
  currentRewardEpochStage = stage;
}

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

async function ensureDraw(epochId: number, program: AirdropDrawProgram) {
  const zeroWork = await hasZeroAirdropWork(epochId, program);
  if (zeroWork) {
    console.log(`[processRewardEpochBounded] epochId=${epochId} program=${program} stage=zero_draw_fast_path`);
    return ensurePublishedZeroAirdropDrawForEpoch(epochId, program);
  }
  return ensurePublishedAirdropDrawForEpoch(epochId, program);
}

export async function runRewardEpochChain(chainId: number) {
  if (!ENV.DATABASE_URL) throw new Error("DATABASE_URL missing");
  const sha = process.env.SOURCE_COMMIT || process.env.COOLIFY_GIT_COMMIT_SHA || process.env.GIT_SHA || "unset";
  const startedAt = Date.now();
  setRewardEpochStage(`chain:${chainId}:boot`);
  console.log(`[processRewardEpochBounded] BUILD_SHA=${sha} chainId=${chainId}`);

  setRewardEpochStage(`chain:${chainId}:ensure_current_epoch`);
  await getCurrentWeeklyEpoch(chainId);

  const epochLimit = Math.max(1, Math.min(52, Number(process.env.PROCESS_REWARD_EPOCH_LIMIT || "1") || 1));
  setRewardEpochStage(`chain:${chainId}:load_ended_epochs`);
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
    setRewardEpochStage(`chain:${chainId}:epoch:${epochId}:eligibility_snapshot`);
    const snapshotComplete = await hasCompleteEligibilitySnapshot(epochId);
    console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=eligibility snapshotComplete=${snapshotComplete}`);

    if (!snapshotComplete) {
      const stageStartedAt = Date.now();
      setRewardEpochStage(`chain:${chainId}:epoch:${epochId}:eligibility_compute`);
      const eligibility = await processRewardEligibilityForEpoch(epochId);
      console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=eligibility_done wallets=${eligibility.walletCount} results=${eligibility.resultCount} durationMs=${elapsedMs(stageStartedAt)}`);
    } else {
      console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=eligibility_reused`);
    }

    let stageStartedAt = Date.now();
    setRewardEpochStage(`chain:${chainId}:epoch:${epochId}:trader_draw`);
    const traderDraw = await ensureDraw(epochId, "airdrop_trader");
    console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=trader_draw_done drawId=${traderDraw.draw.id} winners=${traderDraw.winners.length} durationMs=${elapsedMs(stageStartedAt)}`);

    stageStartedAt = Date.now();
    setRewardEpochStage(`chain:${chainId}:epoch:${epochId}:creator_draw`);
    const creatorDraw = await ensureDraw(epochId, "airdrop_creator");
    console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=creator_draw_done drawId=${creatorDraw.draw.id} winners=${creatorDraw.winners.length} durationMs=${elapsedMs(stageStartedAt)}`);

    stageStartedAt = Date.now();
    setRewardEpochStage(`chain:${chainId}:epoch:${epochId}:zero_finalize`);
    const zeroFinalized = await finalizeStrictZeroRewardEpoch(epochId);
    if (zeroFinalized) {
      console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=zero_epoch_finalized status=${zeroFinalized.status} durationMs=${elapsedMs(stageStartedAt)}`);
      console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=done durationMs=${elapsedMs(epochStartedAt)}`);
      continue;
    }

    stageStartedAt = Date.now();
    setRewardEpochStage(`chain:${chainId}:epoch:${epochId}:materialize`);
    const materialized = await materializeRewardLedgerForEpoch(epochId);
    console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=materialize_done rows=${materialized.materializedCount} durationMs=${elapsedMs(stageStartedAt)}`);

    stageStartedAt = Date.now();
    setRewardEpochStage(`chain:${chainId}:epoch:${epochId}:publish`);
    const published = await publishRewardLedgerForEpoch(epochId, new Date());
    console.log(`[processRewardEpochBounded] chainId=${chainId} epochId=${epochId} stage=publish_done status=${published.epoch.status} claimable=${published.updatedCount} durationMs=${elapsedMs(stageStartedAt)}`);

    if (published.epoch.status === "published" && published.updatedCount > 0) {
      setRewardEpochStage(`chain:${chainId}:epoch:${epochId}:notify`);
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

  setRewardEpochStage(`chain:${chainId}:done`);
  console.log(`[processRewardEpochBounded] chainId=${chainId} processed=${epochs.rows.length} durationMs=${elapsedMs(startedAt)}`);
}
