BEGIN;

-- Import swap fee (0.5%) records for the finance revenue lane "Import swaps 0.5%".
--
-- Imported-coin swaps (frontend/api/importSwap.js, frontend/src/lib/robinhoodImportSwap.mjs) pay a
-- 0.5% platform fee inside the user's swap transaction:
--   Solana 101:   Jupiter platform fee in wrapped SOL to the WSOL token account of the protocol
--                 operator 2AMfRaxS... (SOLANA_IMPORT_SWAP_FEE_OWNER).
--   BNB 56:       KyberSwap extra fee in BNB, paid by the Kyber router to the ProtocolRevenueVault
--                 0xc2d4E6f8... (Deposit event, from = Kyber router).
--   Robinhood:    Universal Router PAY_PORTION in ETH to the ProtocolRevenueVault 0x632061cA...
--                 (Deposit event, from = Universal Router).
-- The API never saw the confirmed swap, so nothing was recorded. The finance cron
-- (cron:finance-snapshots, api/lib/financeImportSwapFees.js) now reads those fee inflows from the
-- chain and stores one row per fee transfer; scripts/finance-import-swap-fees.mjs backfills history.
--
-- 1. finance_import_swap_fees: one row per fee transfer (chain, tx, log index). fee_raw is in the
--    native unit (lamports / wei). wallet is the swap's signer (public on chain); internal_wallet
--    marks our own wallets (shared/ownerWallets.mjs). No personal data beyond the public address.
-- 2. finance_import_swap_fee_cursors: where the scan stopped per chain (newest Solana signature or
--    last EVM block), so each run only reads what is new.
--
-- Nothing here holds or moves funds. RLS on with no policies: only the API (table owner) reads and
-- writes; anon and authenticated get no access.
--
-- Idempotent: safe to run twice. Plain CREATE INDEX (the tables are new and small).

CREATE TABLE IF NOT EXISTS public.finance_import_swap_fees (
  id              bigserial PRIMARY KEY,
  chain_id        integer NOT NULL CHECK (chain_id IN (101, 56, 4663)),
  tx_hash         text NOT NULL CHECK (char_length(tx_hash) BETWEEN 1 AND 120),
  log_index       integer NOT NULL DEFAULT 0 CHECK (log_index >= 0),
  block_number    bigint NULL CHECK (block_number IS NULL OR block_number >= 0),
  occurred_at     timestamptz NOT NULL,
  wallet          text NULL CHECK (wallet IS NULL OR char_length(wallet) BETWEEN 1 AND 64),
  token_address   text NULL CHECK (token_address IS NULL OR char_length(token_address) BETWEEN 1 AND 64),
  side            text NULL CHECK (side IS NULL OR side IN ('buy', 'sell')),
  fee_raw         numeric(78, 0) NOT NULL CHECK (fee_raw > 0),
  fee_asset       text NOT NULL CHECK (fee_asset IN ('SOL', 'BNB', 'ETH')),
  fee_receiver    text NOT NULL CHECK (char_length(fee_receiver) BETWEEN 1 AND 64),
  router          text NULL CHECK (router IS NULL OR char_length(router) BETWEEN 1 AND 64),
  source          text NOT NULL CHECK (source IN ('solana_fee_account', 'evm_vault_deposit')),
  internal_wallet boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS finance_import_swap_fees_chain_time_idx ON public.finance_import_swap_fees (chain_id, occurred_at);

CREATE TABLE IF NOT EXISTS public.finance_import_swap_fee_cursors (
  chain_id   integer PRIMARY KEY CHECK (chain_id IN (101, 56, 4663)),
  cursor     text NOT NULL CHECK (char_length(cursor) BETWEEN 1 AND 120),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finance_import_swap_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_import_swap_fee_cursors ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.finance_import_swap_fees, public.finance_import_swap_fee_cursors FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.finance_import_swap_fees, public.finance_import_swap_fee_cursors FROM authenticated;
  END IF;
END $$;

COMMENT ON TABLE public.finance_import_swap_fees IS 'Import swap 0.5% platform fees read from the chain (Solana fee token account, EVM vault Deposit events). Revenue lane import-swaps. API only.';
COMMENT ON TABLE public.finance_import_swap_fee_cursors IS 'Scan position per chain for finance_import_swap_fees. API only.';

COMMIT;
