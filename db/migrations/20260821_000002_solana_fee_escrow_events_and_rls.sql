-- Replay-safe Solana fee event ledger + backend-only RLS for escrow accounting.

BEGIN;

CREATE TABLE IF NOT EXISTS public.solana_fee_escrow_events (
  id                BIGSERIAL PRIMARY KEY,
  chain_id          INTEGER NOT NULL DEFAULT 101,
  tx_hash           TEXT NOT NULL,
  log_index         INTEGER NOT NULL,
  event_kind        TEXT NOT NULL,
  campaign_address  TEXT NOT NULL,
  escrow_address    TEXT NOT NULL,
  weekly_lamports   NUMERIC(78, 0) NOT NULL DEFAULT 0,
  monthly_lamports  NUMERIC(78, 0) NOT NULL DEFAULT 0,
  recruiter_lamports NUMERIC(78, 0) NOT NULL DEFAULT 0,
  airdrop_lamports  NUMERIC(78, 0) NOT NULL DEFAULT 0,
  squad_lamports    NUMERIC(78, 0) NOT NULL DEFAULT 0,
  protocol_lamports NUMERIC(78, 0) NOT NULL DEFAULT 0,
  total_lamports    NUMERIC(78, 0) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT solana_fee_escrow_events_chain_chk CHECK (chain_id = 101),
  CONSTRAINT solana_fee_escrow_events_kind_chk
    CHECK (event_kind IN ('FeeSlicesAccrued', 'FeeEscrowFlushed', 'FeeEscrowInitialized')),
  CONSTRAINT solana_fee_escrow_events_uidx UNIQUE (chain_id, tx_hash, log_index, event_kind)
);

CREATE INDEX IF NOT EXISTS solana_fee_escrow_events_campaign_idx
  ON public.solana_fee_escrow_events (campaign_address, created_at DESC);

ALTER TABLE public.solana_fee_escrow_accruals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solana_fee_escrow_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.solana_fee_escrow_accruals FROM anon;
    REVOKE ALL ON TABLE public.solana_fee_escrow_events FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.solana_fee_escrow_accruals FROM authenticated;
    REVOKE ALL ON TABLE public.solana_fee_escrow_events FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.solana_fee_escrow_accruals TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.solana_fee_escrow_events TO service_role;
    GRANT USAGE, SELECT ON SEQUENCE public.solana_fee_escrow_accruals_id_seq TO service_role;
    GRANT USAGE, SELECT ON SEQUENCE public.solana_fee_escrow_events_id_seq TO service_role;
  END IF;
END
$$;

COMMIT;
