-- Gen-8 widget partner ledger (founder, 2026-10-22). PRODUCTION, Supabase SQL editor (project ellkfgoxnzykxqybajtn).
-- Same statements as db/migrations/20261022_000010_gen8_partner_fees.sql, with a prerequisite check first.
--
-- What it does: creates gen8_partner_fees (the ledger), gen8_partner_fee_cursors, gen8_partner_topups, adds
-- import_fee_transfers.gen8_raw (default 0: every existing row stays valid and reads as an import payout) and one
-- partial index on evm_gen8_fee_accruals. It moves no money and changes no existing row. RLS on, no policies, anon and
-- authenticated revoked, like the other import fee tables. Idempotent: safe to run twice.
--
-- Run it BEFORE deploying the indexer that carries gen8PartnerFees.ts (the payout worker only reads the gen-8 ledger
-- once all three tables and the column exist; until then it runs exactly as today).
--
-- How: paste the whole file, Run. Then run the check at the bottom on its own; it must list 3 tables and gen8_raw.

BEGIN;

-- Prerequisites: the gen-8 indexer tables and the import fee partner migrations must already be applied.
DO $$
BEGIN
  IF to_regclass('public.evm_gen8_fee_accruals') IS NULL THEN
    RAISE EXCEPTION 'evm_gen8_fee_accruals is missing: apply db/migrations/20261011_000010_evm_gen8_indexer.sql first';
  END IF;
  IF to_regclass('public.import_fee_transfers') IS NULL OR to_regclass('public.import_fee_partners') IS NULL OR to_regclass('public.import_swap_fingerprints') IS NULL THEN
    RAISE EXCEPTION 'import fee tables are missing: apply 20261008_000020_import_creator_fees.sql and 20261009_000010_import_fee_partners.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'import_fee_transfers' AND column_name = 'partner_id') THEN
    RAISE EXCEPTION 'import_fee_transfers.partner_id is missing: apply 20261009_000010_import_fee_partners.sql first';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.gen8_partner_fees (
  id             bigserial PRIMARY KEY,
  chain_id       integer NOT NULL CHECK (chain_id IN (56, 4663, 97, 46630)),
  hook_address   text NOT NULL CHECK (hook_address ~ '^0x[0-9a-f]{40}$'),
  accrual_id     bigint NOT NULL,
  tx_hash        text NOT NULL CHECK (char_length(tx_hash) BETWEEN 1 AND 120),
  log_index      integer NOT NULL CHECK (log_index >= 0),
  token_address  text NOT NULL CHECK (char_length(token_address) BETWEEN 1 AND 64),
  partner_id     text NOT NULL CHECK (char_length(partner_id) BETWEEN 1 AND 41),
  fingerprint    text NOT NULL CHECK (char_length(fingerprint) BETWEEN 16 AND 128),
  curve_amount   numeric(78, 0) NOT NULL CHECK (curve_amount > 0),
  partner_raw    numeric(78, 0) NOT NULL CHECK (partner_raw > 0),
  block_time     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash, log_index),
  UNIQUE (accrual_id),
  FOREIGN KEY (chain_id, tx_hash, log_index) REFERENCES public.evm_gen8_fee_accruals (chain_id, tx_hash, log_index) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS gen8_partner_fees_partner_idx ON public.gen8_partner_fees (chain_id, partner_id);

CREATE TABLE IF NOT EXISTS public.gen8_partner_fee_cursors (
  chain_id        integer NOT NULL CHECK (chain_id IN (56, 4663, 97, 46630)),
  hook_address    text NOT NULL CHECK (hook_address ~ '^0x[0-9a-f]{40}$'),
  last_accrual_id bigint NOT NULL CHECK (last_accrual_id >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, hook_address)
);
ALTER TABLE public.gen8_partner_fee_cursors ADD COLUMN IF NOT EXISTS stalled_tx_hash text NULL CHECK (stalled_tx_hash IS NULL OR char_length(stalled_tx_hash) BETWEEN 1 AND 120);
ALTER TABLE public.gen8_partner_fee_cursors ADD COLUMN IF NOT EXISTS stalled_accrual_id bigint NULL;
ALTER TABLE public.gen8_partner_fee_cursors ADD COLUMN IF NOT EXISTS stalled_failures integer NOT NULL DEFAULT 0 CHECK (stalled_failures >= 0);
ALTER TABLE public.gen8_partner_fee_cursors ADD COLUMN IF NOT EXISTS stalled_error text NULL CHECK (stalled_error IS NULL OR char_length(stalled_error) <= 500);
ALTER TABLE public.gen8_partner_fee_cursors ADD COLUMN IF NOT EXISTS stalled_since timestamptz NULL;
ALTER TABLE public.gen8_partner_fee_cursors ADD COLUMN IF NOT EXISTS stalled_warned_at timestamptz NULL;

-- The attribution scan: post-graduation trade accruals of one chain, in id order after the cursor.
CREATE INDEX IF NOT EXISTS evm_gen8_fee_accruals_post_trade_idx
  ON public.evm_gen8_fee_accruals (chain_id, id) WHERE kind = 'trade' AND phase = 'post';

ALTER TABLE public.import_fee_transfers ADD COLUMN IF NOT EXISTS gen8_raw numeric(78, 0) NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_fee_transfers_gen8_raw_check') THEN
    ALTER TABLE public.import_fee_transfers
      ADD CONSTRAINT import_fee_transfers_gen8_raw_check CHECK (gen8_raw >= 0 AND gen8_raw <= amount_raw AND (gen8_raw = 0 OR kind = 'partner'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS import_fee_transfers_partner_idx ON public.import_fee_transfers (chain_id, partner_id) WHERE kind = 'partner';

CREATE TABLE IF NOT EXISTS public.gen8_partner_topups (
  id           bigserial PRIMARY KEY,
  chain_id     integer NOT NULL CHECK (chain_id IN (56, 4663, 97, 46630)),
  vault        text NOT NULL CHECK (vault ~ '^0x[0-9a-f]{40}$'),
  tx_hash      text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  amount_raw   numeric(78, 0) NOT NULL CHECK (amount_raw > 0),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  note         text NULL CHECK (note IS NULL OR char_length(note) <= 200),
  error        text NULL CHECK (error IS NULL OR char_length(error) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now(),
  verified_at  timestamptz NULL,
  UNIQUE (chain_id, tx_hash)
);

ALTER TABLE public.gen8_partner_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gen8_partner_fee_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gen8_partner_topups ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.gen8_partner_fees, public.gen8_partner_fee_cursors, public.gen8_partner_topups FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.gen8_partner_fees, public.gen8_partner_fee_cursors, public.gen8_partner_topups FROM authenticated;
  END IF;
END $$;

COMMENT ON TABLE public.gen8_partner_fees IS 'Swap-widget partner share (0.25% of volume) of graduated gen-8 coin swaps built by the widget; paid from the ImportFeeVault out of MemeWarzone''s import share.';
COMMENT ON TABLE public.gen8_partner_fee_cursors IS 'Last gen-8 accrual id checked for partner attribution per chain and hook.';
COMMENT ON COLUMN public.import_fee_transfers.gen8_raw IS 'Part of a partner payout that pays gen-8 partner dues (gen8_partner_fees); the rest pays the import share.';
COMMENT ON TABLE public.gen8_partner_topups IS 'Safe top-ups of an ImportFeeVault for gen-8 partner payouts; counted once verified on chain.';

COMMIT;

-- Check (read only): expect gen8_partner_fees, gen8_partner_fee_cursors, gen8_partner_topups, then gen8_raw, then
-- 0 rows with gen8_raw > 0.
select table_name from information_schema.tables
 where table_schema = 'public' and table_name in ('gen8_partner_fees', 'gen8_partner_fee_cursors', 'gen8_partner_topups')
 order by table_name;
select column_name, data_type, column_default from information_schema.columns
 where table_schema = 'public' and table_name = 'import_fee_transfers' and column_name = 'gen8_raw';
select count(*) as transfers_with_gen8 from public.import_fee_transfers where gen8_raw > 0;
