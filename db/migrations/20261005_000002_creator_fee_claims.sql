-- Creator fee claims, one row per claim event, written by the realtime indexer.
--
-- Solana: claim_creator_fees emits CreatorFeeClaimed { campaign, creator,
-- creator_fee_vault, amount_lamports, total_claimed }. The indexer records each
-- one as it sees the launchpad's transactions (solanaCreatorFeeClaims.ts) and a
-- one-off job backfills every claim from each coin's creator fee vault history
-- (job:backfill-creator-fee-claims). The finance Payouts page reads this table
-- and checks it against the vault's own running total; a coin whose rows do not
-- add up is read from the chain instead, so a late or missing row never shows
-- a wrong total.
--
-- chain_id + asset leave room for other chains; only Solana (101) writes here
-- today. EVM claims of CreatorRewardsVaultV2 are already in evm_campaign_events.
--
-- Idempotent. Backend-only: RLS on, no policies, anon/authenticated revoked.

BEGIN;

CREATE TABLE IF NOT EXISTS public.creator_fee_claims (
  id                  BIGSERIAL PRIMARY KEY,
  chain_id            INTEGER NOT NULL,
  campaign_address    TEXT NOT NULL,
  creator_wallet      TEXT NOT NULL,
  fee_account         TEXT,
  amount_raw          NUMERIC(78, 0) NOT NULL CHECK (amount_raw >= 0),
  total_claimed_raw   NUMERIC(78, 0),
  asset               TEXT NOT NULL DEFAULT 'SOL',
  tx_signature        TEXT NOT NULL,
  log_index           INTEGER NOT NULL DEFAULT 0,
  slot                BIGINT,
  block_time          TIMESTAMPTZ,
  source              TEXT NOT NULL DEFAULT 'indexer',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One claim instruction emits one event; a transaction can hold more than one claim.
  CONSTRAINT creator_fee_claims_event_uidx UNIQUE (chain_id, tx_signature, log_index)
);

CREATE INDEX IF NOT EXISTS creator_fee_claims_campaign_idx
  ON public.creator_fee_claims (chain_id, campaign_address, block_time DESC);
CREATE INDEX IF NOT EXISTS creator_fee_claims_creator_idx
  ON public.creator_fee_claims (chain_id, creator_wallet, block_time DESC);

ALTER TABLE public.creator_fee_claims ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.creator_fee_claims FROM anon;
    REVOKE ALL ON SEQUENCE public.creator_fee_claims_id_seq FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.creator_fee_claims FROM authenticated;
    REVOKE ALL ON SEQUENCE public.creator_fee_claims_id_seq FROM authenticated;
  END IF;
END $$;

COMMIT;
