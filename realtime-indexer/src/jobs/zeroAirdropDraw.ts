import crypto from "node:crypto";
import { pool } from "../db.js";
import { ENV } from "../env.js";
import {
  getPublishedAirdropDrawForEpoch,
  type AirdropDrawProgram,
  type RunAirdropDrawResult,
} from "../rewards/airdrops.js";
import { getEpochById } from "../rewards/epochs.js";

export async function hasZeroAirdropWork(epochId: number, program: AirdropDrawProgram): Promise<boolean> {
  const result = await pool.query(
    `select
       exists(
         select 1
           from public.reward_events
          where epoch_id=$1
            and airdrop_amount <> 0
       ) as has_funding,
       exists(
         select 1
           from public.eligibility_results
          where epoch_id=$1
            and program=$2
            and is_eligible=true
            and score > 0
       ) as has_candidates`,
    [epochId, program],
  );

  return !Boolean(result.rows[0]?.has_funding) && !Boolean(result.rows[0]?.has_candidates);
}

export async function ensurePublishedZeroAirdropDrawForEpoch(
  epochId: number,
  program: AirdropDrawProgram,
): Promise<RunAirdropDrawResult> {
  const existing = await getPublishedAirdropDrawForEpoch(epochId, program);
  if (existing) return { draw: existing, winners: [] };

  const epoch = await getEpochById(epochId);
  if (!epoch) throw new Error(`Reward epoch ${epochId} not found`);

  const seed = crypto
    .createHash("sha256")
    .update(`${epoch.chainId}:${epoch.id}:${program}:${epoch.startAt}:${epoch.endAt}:${ENV.AIRDROP_DRAW_SEED_SALT}`)
    .digest("hex");

  await pool.query(
    `insert into public.airdrop_draws(
       epoch_id, chain_id, program, status, seed, pool_amount, candidate_count,
       eligible_candidate_count, winner_count, config_json, audit_json, created_by,
       published_at, created_at, updated_at
     ) values (
       $1, $2, $3, 'published', $4, 0, 0,
       0, 0, $5::jsonb, $6::jsonb, 'weekly_reward_epoch_zero',
       now(), now(), now()
     )
     on conflict (epoch_id, program) where status='published'
     do nothing`,
    [
      epoch.id,
      epoch.chainId,
      program,
      seed,
      JSON.stringify({
        baseWinnerCount: ENV.AIRDROP_BASE_WINNER_COUNT,
        winnerCountPerBnb: ENV.AIRDROP_WINNER_COUNT_PER_BNB,
        maxWinnerCount: ENV.AIRDROP_MAX_WINNER_COUNT,
        weightTierStepBnb: ENV.AIRDROP_WEIGHT_TIER_STEP_BNB,
        maxWeightTier: ENV.AIRDROP_MAX_WEIGHT_TIER,
        payoutSplit: "equal_share_plus_remainder",
      }),
      JSON.stringify({ zeroRewardWeek: true, rounds: [] }),
    ],
  );

  const draw = await getPublishedAirdropDrawForEpoch(epochId, program);
  if (!draw) throw new Error(`Failed to persist zero-value ${program} draw for epoch ${epochId}`);
  return { draw, winners: [] };
}
