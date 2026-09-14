BEGIN;

ALTER TABLE public.arena_war_pool_claims
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS source_kind text,
  ADD COLUMN IF NOT EXISTS event_index integer,
  ADD COLUMN IF NOT EXISTS gross_amount_wei numeric,
  ADD COLUMN IF NOT EXISTS monthly_amount_wei numeric,
  ADD COLUMN IF NOT EXISTS quarterly_amount_wei numeric,
  ADD COLUMN IF NOT EXISTS authority_address text,
  ADD COLUMN IF NOT EXISTS receipt_address text,
  ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;

ALTER TABLE public.arena_war_pool_claims
  ADD CONSTRAINT arena_war_pool_claims_mwl_financial_shape_check
  CHECK (
    bucket <> 'mwl'
    OR (
      source_id IS NOT NULL
      AND gross_amount_wei IS NOT NULL
      AND monthly_amount_wei IS NOT NULL
      AND quarterly_amount_wei IS NOT NULL
      AND gross_amount_wei > 0
      AND gross_amount_wei = monthly_amount_wei + quarterly_amount_wei
      AND monthly_amount_wei = floor(gross_amount_wei * 6000 / 10000)
      AND quarterly_amount_wei = gross_amount_wei - monthly_amount_wei
      AND amount_wei = gross_amount_wei
      AND reconciled_at IS NOT NULL
    )
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS arena_war_pool_claims_chain_source_mwl_idx
  ON public.arena_war_pool_claims (chain_id, source_id)
  WHERE bucket = 'mwl' AND source_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS arena_war_pool_claims_chain_tx_mwl_idx
  ON public.arena_war_pool_claims (chain_id, tx_hash)
  WHERE bucket = 'mwl';

CREATE UNIQUE INDEX IF NOT EXISTS arena_war_pool_claims_chain_tx_event_mwl_idx
  ON public.arena_war_pool_claims (chain_id, tx_hash, COALESCE(event_index, -1))
  WHERE bucket = 'mwl';

COMMIT;
