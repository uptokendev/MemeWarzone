-- Live solana_reward_lane_batches already existed without deadline.
-- Jobs no longer write this column; ADD COLUMN keeps older publishers working.

ALTER TABLE public.solana_reward_lane_batches
  ADD COLUMN IF NOT EXISTS deadline bigint;
