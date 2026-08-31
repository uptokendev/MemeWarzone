import { pool } from "../db.js";
import { getEpochById, type RewardEpochRecord } from "../rewards/epochs.js";

const REQUIRED_AIRDROP_PROGRAMS = ["airdrop_trader", "airdrop_creator"] as const;

export async function finalizeStrictZeroRewardEpoch(epochId: number): Promise<RewardEpochRecord | null> {
  const result = await pool.query(
    `update public.epochs e
        set status = 'published',
            finalized_at = coalesce(finalized_at, now())
      where e.id = $1
        and e.status in ('open','processing','finalized')
        and not exists (
          select 1
            from public.reward_events re
           where re.epoch_id = e.id
        )
        and not exists (
          select 1
            from public.eligibility_results er
           where er.epoch_id = e.id
             and er.is_eligible = true
             and er.score > 0
        )
        and not exists (
          select 1
            from public.reward_ledger_entries le
           where le.epoch_id = e.id
        )
        and (
          select count(*)::int
            from public.airdrop_draws d
           where d.epoch_id = e.id
             and d.program = any($2::text[])
             and d.status = 'published'
             and d.pool_amount = 0
             and d.winner_count = 0
        ) = $3
      returning e.id`,
    [epochId, [...REQUIRED_AIRDROP_PROGRAMS], REQUIRED_AIRDROP_PROGRAMS.length],
  );

  if ((result.rowCount ?? 0) === 0) return null;
  return getEpochById(epochId);
}
