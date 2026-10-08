BEGIN;

-- Import swap fee 1%, half to the coin's creator (founder, 2026-10-08).
--
-- Imported-coin swaps pay 1% of the native side to ONE receiver per chain (Solana: the wrapped-SOL
-- account of the import fee collector key; BNB / Robinhood: an ImportFeeVault). Half is the
-- protocol's, half belongs to the coin's creator. The split happens afterwards, never inside the
-- trader's transaction. The creator's half waits 90 days per trade; it is paid automatically to the
-- verified owner (arena_token_imports.ownership_status = 'ownership_verified', project_owner_wallet)
-- once the claim is 7 days old, and expires to the protocol wallet after 90 days.
--
-- 1. finance_import_swap_fees.creator_raw: the creator's half of a fee row. 0 for rows paid to the
--    old 0.5% receivers (100% protocol). The revenue lane counts fee_raw - creator_raw.
-- 2. finance_import_swap_fee_receiver_cursors: scan position per (chain, receiver) for the new
--    receivers. The old per-chain cursor table keeps serving the old receivers unchanged.
-- 3. import_creator_fees: one row per creator accrual (= one split fee row).
--      waiting  inside 90 days, not yet paid
--      paying   part of a payout that was signed and may have landed
--      paid     the payout landed
--      expired  older than 90 days when it was not paid; swept to the protocol wallet
-- 4. import_fee_transfers: every movement out of a receiver (creator payout or protocol sweep).
--    Sign, store as 'sending' with the signature, send, resolve on the next pass; a send that may
--    have landed is never reset. Amounts in the native unit (lamports / wei).
--
-- RLS on with no policies: only the API and the indexer (table owner) read and write; anon and
-- authenticated get no access. The coin page reads totals through the API.
--
-- Idempotent: safe to run twice.

-- Testnets (97, 46630, DogeOS 6281971) may write ledger rows so the testnet runs exercise the
-- split; finance never reads them (revenue lanes query mainnet chain ids only).
ALTER TABLE public.finance_import_swap_fees DROP CONSTRAINT IF EXISTS finance_import_swap_fees_chain_id_check;
ALTER TABLE public.finance_import_swap_fees
  ADD CONSTRAINT finance_import_swap_fees_chain_id_check CHECK (chain_id IN (101, 56, 4663, 97, 46630, 6281971));

ALTER TABLE public.finance_import_swap_fees
  ADD COLUMN IF NOT EXISTS creator_raw numeric(78, 0) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_import_swap_fees_creator_raw_check') THEN
    ALTER TABLE public.finance_import_swap_fees
      ADD CONSTRAINT finance_import_swap_fees_creator_raw_check CHECK (creator_raw >= 0 AND creator_raw <= fee_raw);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.finance_import_swap_fee_receiver_cursors (
  chain_id   integer NOT NULL CHECK (chain_id IN (101, 56, 4663, 97, 46630, 6281971)),
  receiver   text NOT NULL CHECK (char_length(receiver) BETWEEN 1 AND 64),
  cursor     text NOT NULL CHECK (char_length(cursor) BETWEEN 1 AND 120),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, receiver)
);

CREATE TABLE IF NOT EXISTS public.import_fee_transfers (
  id                      bigserial PRIMARY KEY,
  chain_id                integer NOT NULL CHECK (chain_id IN (101, 56, 4663, 97, 46630, 6281971)),
  kind                    text NOT NULL CHECK (kind IN ('creator', 'protocol')),
  from_address            text NOT NULL CHECK (char_length(from_address) BETWEEN 1 AND 64),
  to_address              text NOT NULL CHECK (char_length(to_address) BETWEEN 1 AND 64),
  token_address           text NULL CHECK (token_address IS NULL OR char_length(token_address) BETWEEN 1 AND 64),
  amount_raw              numeric(78, 0) NOT NULL CHECK (amount_raw > 0),
  status                  text NOT NULL CHECK (status IN ('sending', 'landed', 'failed')),
  signature               text NULL CHECK (signature IS NULL OR char_length(signature) BETWEEN 1 AND 120),
  last_valid_block_height bigint NULL,
  error                   text NULL CHECK (error IS NULL OR char_length(error) <= 500),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_fee_transfers_status_idx ON public.import_fee_transfers (chain_id, status);
CREATE INDEX IF NOT EXISTS import_fee_transfers_day_idx ON public.import_fee_transfers (chain_id, kind, created_at);

CREATE TABLE IF NOT EXISTS public.import_creator_fees (
  fee_id        bigint PRIMARY KEY REFERENCES public.finance_import_swap_fees (id) ON DELETE RESTRICT,
  chain_id      integer NOT NULL CHECK (chain_id IN (101, 56, 4663, 97, 46630, 6281971)),
  token_address text NULL CHECK (token_address IS NULL OR char_length(token_address) BETWEEN 1 AND 64),
  creator_raw   numeric(78, 0) NOT NULL CHECK (creator_raw > 0),
  occurred_at   timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'paying', 'paid', 'expired')),
  transfer_id   bigint NULL REFERENCES public.import_fee_transfers (id) ON DELETE RESTRICT,
  expired_at    timestamptz NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('paying', 'paid')) = (transfer_id IS NOT NULL)),
  CHECK ((status = 'expired') = (expired_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS import_creator_fees_token_idx ON public.import_creator_fees (chain_id, token_address, status);
CREATE INDEX IF NOT EXISTS import_creator_fees_expiry_idx ON public.import_creator_fees (status, expires_at);

ALTER TABLE public.finance_import_swap_fee_receiver_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_fee_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_creator_fees ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.finance_import_swap_fee_receiver_cursors, public.import_fee_transfers, public.import_creator_fees FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.finance_import_swap_fee_receiver_cursors, public.import_fee_transfers, public.import_creator_fees FROM authenticated;
  END IF;
END $$;

COMMENT ON COLUMN public.finance_import_swap_fees.creator_raw IS 'Creator half of a 1% import swap fee (0 for the old 0.5% receivers). Revenue = fee_raw - creator_raw.';
COMMENT ON TABLE public.import_creator_fees IS 'Creator half of each 1% import swap fee: waiting 90 days, paid to the verified import owner, else expired to the protocol wallet.';
COMMENT ON TABLE public.import_fee_transfers IS 'Creator payouts and protocol sweeps out of the import fee receivers (sign, store, send, resolve).';

COMMIT;
