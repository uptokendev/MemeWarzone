-- Per-campaign Solana fee escrow queue. Case-sensitive Solana addresses.
-- Accrual is revenue; flush is movement only.

BEGIN;

CREATE TABLE IF NOT EXISTS public.solana_fee_escrow_accruals (
  id                  BIGSERIAL PRIMARY KEY,
  chain_id            INTEGER NOT NULL DEFAULT 101,
  campaign_address    TEXT NOT NULL,
  escrow_address      TEXT NOT NULL,
  init_status         TEXT NOT NULL DEFAULT 'pending',
  init_signature      TEXT,
  weekly_accrued      NUMERIC(78, 0) NOT NULL DEFAULT 0,
  monthly_accrued     NUMERIC(78, 0) NOT NULL DEFAULT 0,
  recruiter_accrued   NUMERIC(78, 0) NOT NULL DEFAULT 0,
  airdrop_accrued     NUMERIC(78, 0) NOT NULL DEFAULT 0,
  squad_accrued       NUMERIC(78, 0) NOT NULL DEFAULT 0,
  protocol_accrued    NUMERIC(78, 0) NOT NULL DEFAULT 0,
  weekly_flushed      NUMERIC(78, 0) NOT NULL DEFAULT 0,
  monthly_flushed     NUMERIC(78, 0) NOT NULL DEFAULT 0,
  recruiter_flushed   NUMERIC(78, 0) NOT NULL DEFAULT 0,
  airdrop_flushed     NUMERIC(78, 0) NOT NULL DEFAULT 0,
  squad_flushed       NUMERIC(78, 0) NOT NULL DEFAULT 0,
  protocol_flushed    NUMERIC(78, 0) NOT NULL DEFAULT 0,
  first_accrued_at    TIMESTAMPTZ,
  last_accrued_at     TIMESTAMPTZ,
  last_flush_at       TIMESTAMPTZ,
  last_flush_signature TEXT,
  flush_status        TEXT NOT NULL DEFAULT 'idle',
  flush_attempts      INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT solana_fee_escrow_accruals_chain_chk CHECK (chain_id = 101),
  CONSTRAINT solana_fee_escrow_accruals_init_chk
    CHECK (init_status IN ('pending', 'initialized', 'failed')),
  CONSTRAINT solana_fee_escrow_accruals_flush_chk
    CHECK (flush_status IN ('idle', 'queued', 'submitted', 'confirmed', 'failed')),
  CONSTRAINT solana_fee_escrow_accruals_campaign_uidx UNIQUE (chain_id, campaign_address)
);

CREATE INDEX IF NOT EXISTS solana_fee_escrow_init_idx
  ON public.solana_fee_escrow_accruals (init_status, updated_at);

CREATE INDEX IF NOT EXISTS solana_fee_escrow_flush_idx
  ON public.solana_fee_escrow_accruals (flush_status, last_accrued_at);

COMMIT;
