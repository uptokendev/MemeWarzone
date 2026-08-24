-- Transaction-pool-safe worker leases (Supabase :6543) plus FeeEscrow retry /
-- graduation force-flush columns and TradeAuthorization cleanup queue.

BEGIN;

CREATE TABLE IF NOT EXISTS public.solana_worker_leases (
  worker_name      TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  heartbeat_at     TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.solana_fee_escrow_accruals
  ADD COLUMN IF NOT EXISTS init_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_init_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_init_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS graduation_requested BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS solana_fee_escrow_init_retry_idx
  ON public.solana_fee_escrow_accruals (init_status, next_init_attempt_at, updated_at);

CREATE INDEX IF NOT EXISTS solana_fee_escrow_pending_flush_idx
  ON public.solana_fee_escrow_accruals (
    chain_id,
    init_status,
    graduation_requested,
    last_accrued_at
  );

CREATE TABLE IF NOT EXISTS public.solana_trade_authorizations (
  chain_id          INTEGER NOT NULL DEFAULT 101,
  campaign_address  TEXT NOT NULL,
  trader            TEXT NOT NULL,
  nonce_hex         TEXT NOT NULL,
  trade_auth_pda    TEXT NOT NULL,
  deadline          TIMESTAMPTZ NOT NULL,
  side              TEXT NOT NULL,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleanup_status    TEXT NOT NULL DEFAULT 'pending',
  cleanup_signature TEXT,
  last_error        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT solana_trade_authorizations_chain_chk CHECK (chain_id = 101),
  CONSTRAINT solana_trade_authorizations_side_chk CHECK (side IN ('buy', 'sell')),
  CONSTRAINT solana_trade_authorizations_status_chk
    CHECK (cleanup_status IN ('pending', 'submitted', 'closed', 'no_account', 'failed')),
  CONSTRAINT solana_trade_authorizations_pda_uidx UNIQUE (chain_id, trade_auth_pda)
);

CREATE INDEX IF NOT EXISTS solana_trade_authorizations_cleanup_idx
  ON public.solana_trade_authorizations (cleanup_status, deadline);

ALTER TABLE public.solana_worker_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solana_trade_authorizations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public.solana_worker_leases FROM anon;
    REVOKE ALL ON TABLE public.solana_trade_authorizations FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public.solana_worker_leases FROM authenticated;
    REVOKE ALL ON TABLE public.solana_trade_authorizations FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.solana_worker_leases TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.solana_trade_authorizations TO service_role;
  END IF;
END
$$;

COMMIT;
