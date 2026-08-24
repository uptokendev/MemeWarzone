-- Preserve Solana case on recruiter settlement ledgers and join SolKillers
-- (recruiter_id 114) even when wallet_address casing differs.

BEGIN;

ALTER TABLE IF EXISTS public.reward_ledger_entries
  DROP CONSTRAINT IF EXISTS reward_ledger_entries_wallet_lowercase;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS table_name, c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE c.contype = 'c'
       AND n.nspname = 'public'
       AND t.relname = 'reward_ledger_entries'
       AND pg_get_constraintdef(c.oid) ~* 'lower\s*\('
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.table_name, r.conname);
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.solana_reward_lane_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id integer NOT NULL,
  lane text NOT NULL,
  epoch_id bigint NOT NULL,
  program_id text,
  vault_address text,
  batch_address text,
  merkle_root text,
  total_lamports numeric(78,0) NOT NULL DEFAULT 0,
  deadline bigint,
  status text NOT NULL DEFAULT 'ready',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, lane, epoch_id)
);

ALTER TABLE public.solana_reward_lane_batches
  ADD COLUMN IF NOT EXISTS deadline bigint;

CREATE TABLE IF NOT EXISTS public.solana_reward_lane_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES public.solana_reward_lane_batches(id) ON DELETE CASCADE,
  lane text NOT NULL,
  source_type text NOT NULL,
  source_ref text NOT NULL,
  wallet_address text NOT NULL,
  amount_lamports numeric(78,0) NOT NULL,
  merkle_proof jsonb NOT NULL DEFAULT '[]'::jsonb,
  claim_receipt_address text,
  status text NOT NULL DEFAULT 'pending',
  tx_hash text,
  error text,
  claimed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, wallet_address),
  UNIQUE (lane, source_type, source_ref)
);

CREATE OR REPLACE VIEW public.recruiter_claimable_settlements AS
WITH claimable_entries AS (
  SELECT
    l.epoch_id,
    e.chain_id,
    e.epoch_type,
    e.start_at,
    e.end_at,
    l.wallet_address,
    count(*)::bigint AS claimable_entry_count,
    coalesce(sum(l.net_amount), 0)::numeric(78,0) AS claimable_amount,
    min(l.claimable_at) AS first_claimable_at,
    max(l.claim_deadline_at) AS claim_deadline_at,
    array_agg(l.id ORDER BY l.id) AS ledger_entry_ids
  FROM public.reward_ledger_entries l
  JOIN public.epochs e ON e.id = l.epoch_id
  WHERE l.program = 'recruiter'
    AND l.status = 'claimable'
  GROUP BY
    l.epoch_id,
    e.chain_id,
    e.epoch_type,
    e.start_at,
    e.end_at,
    l.wallet_address
)
SELECT
  ce.epoch_id,
  ce.chain_id,
  ce.epoch_type,
  ce.start_at,
  ce.end_at,
  r.id AS recruiter_id,
  r.wallet_address AS recruiter_wallet_address,
  r.code AS recruiter_code,
  r.display_name AS recruiter_display_name,
  r.is_og AS recruiter_is_og,
  r.status AS recruiter_status,
  r.closed_at AS recruiter_closed_at,
  ce.wallet_address,
  ce.claimable_entry_count,
  ce.claimable_amount,
  ce.first_claimable_at,
  ce.claim_deadline_at,
  ce.ledger_entry_ids,
  now() AS materialized_at
FROM claimable_entries ce
LEFT JOIN LATERAL (
  SELECT l.source_reference->>'recruiterId' AS recruiter_id
    FROM public.reward_ledger_entries l
   WHERE l.id = ce.ledger_entry_ids[1]
   LIMIT 1
) src ON true
LEFT JOIN public.recruiters r
  ON r.wallet_address = ce.wallet_address
  OR lower(r.wallet_address) = lower(ce.wallet_address)
  OR (src.recruiter_id IS NOT NULL AND r.id = nullif(src.recruiter_id, '')::bigint);

COMMIT;
