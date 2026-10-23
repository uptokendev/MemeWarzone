-- Swap widget usage and revenue tracking (2026-10-23). Observation only: nothing here changes a swap, a fee, a
-- partner split or a payout. The API writes these rows best effort (batched every 15 s, off the request path); a
-- missing table only means nothing is counted.
--
-- 1. widget_usage_daily: one counter per UTC day, chain, partner ('' = none), embedding website and event
--    (frontend/api/lib/widgetTracking.js). host is the hostname of the request's Origin (else Referer), lower case,
--    without "www.", at most 120 characters, '' when the browser sent neither; 'other' once a (day, chain) already has
--    500 named sites. No IP address, no wallet, no visitor id, no cookie. Events: load (token lookup), quote, build (a
--    swap transaction was handed out), approval (a sell needed an allowance first), bonding_trade (a Solana launchpad
--    bonding trade was authorized for the widget).
-- 2. widget_swap_builds: every swap the API built for the widget (partner or not), with the same fingerprint the
--    partner attribution records (api/lib/importSwapFingerprint.js: Solana sha256(wallet:Jupiter ix data), EVM
--    keccak(to:data:value)) and the wallet the build is for, only to match the landed swap. Builds that never matched
--    a landed swap are deleted after 30 days by the API (api/lib/widgetSwapLedger.js); matched ones stay. Never
--    written by the app's own /api/imports/swap routes. import_swap_fingerprints and the partner attribution are
--    unchanged.
-- 3. finance_import_swap_fees: landed_fingerprint (the scanner's fingerprint of the landed transaction, kept only when
--    the row's wallet is the landed wallet), swap_source ('widget' or null), widget_host and widget_build_id (set when
--    the landed fingerprint and wallet match a widget build). All nullable without a default: adding them rewrites no
--    row. No amount column changes.
--
-- Locks: the CHECK on finance_import_swap_fees is added NOT VALID inside the transaction and validated after it
-- (VALIDATE takes a lighter lock). Indexes on the existing large tables (finance_import_swap_fees,
-- evm_gen8_fee_accruals) are built in a second transaction after COMMIT, with plain CREATE INDEX (the Supabase SQL editor
-- wraps every run in a transaction, so CONCURRENTLY is not possible there; these tables are small).
--
-- RLS on, no policies: API only (same as the other import fee tables); anon and authenticated revoked.
-- Idempotent: safe to run twice. Nothing is dropped or rewritten.

BEGIN;

-- Prerequisites: the import fee ledger with its partner columns, and the gen-8 accruals (indexed below).
DO $$
BEGIN
  IF to_regclass('public.finance_import_swap_fees') IS NULL THEN
    RAISE EXCEPTION 'finance_import_swap_fees is missing: apply db/migrations/20261006_000002_finance_import_swap_fees.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'finance_import_swap_fees' AND column_name = 'creator_raw') THEN
    RAISE EXCEPTION 'finance_import_swap_fees.creator_raw is missing: apply db/migrations/20261008_000020_import_creator_fees.sql first';
  END IF;
  IF to_regclass('public.import_fee_partners') IS NULL OR to_regclass('public.import_swap_fingerprints') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'finance_import_swap_fees' AND column_name = 'partner_raw') THEN
    RAISE EXCEPTION 'import fee partner tables are missing: apply db/migrations/20261009_000010_import_fee_partners.sql first';
  END IF;
  IF to_regclass('public.evm_gen8_fee_accruals') IS NULL THEN
    RAISE EXCEPTION 'evm_gen8_fee_accruals is missing: apply db/migrations/20261011_000010_evm_gen8_indexer.sql first';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.widget_usage_daily (
  day         date NOT NULL,
  chain_id    integer NOT NULL CHECK (chain_id IN (101, 56, 4663, 97, 46630)),
  partner_id  text NOT NULL DEFAULT '' CHECK (partner_id = '' OR partner_id ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  host        text NOT NULL DEFAULT '' CHECK (char_length(host) <= 120),
  event       text NOT NULL CHECK (event IN ('load', 'quote', 'build', 'approval', 'bonding_trade')),
  count       bigint NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day, chain_id, partner_id, host, event)
);
-- The 500-site cap reads the named hosts of one (day, chain).
CREATE INDEX IF NOT EXISTS widget_usage_daily_day_host_idx ON public.widget_usage_daily (day, chain_id, host);

CREATE TABLE IF NOT EXISTS public.widget_swap_builds (
  id             bigserial PRIMARY KEY,
  fingerprint    text NOT NULL CHECK (char_length(fingerprint) BETWEEN 16 AND 128),
  chain_id       integer NOT NULL CHECK (chain_id IN (101, 56, 4663, 97, 46630)),
  kind           text NOT NULL CHECK (kind IN ('import', 'gen8')),
  wallet         text NOT NULL CHECK (char_length(wallet) BETWEEN 1 AND 64),
  token_address  text NULL CHECK (token_address IS NULL OR char_length(token_address) BETWEEN 1 AND 64),
  side           text NULL CHECK (side IS NULL OR side IN ('buy', 'sell')),
  partner_id     text NULL CHECK (partner_id IS NULL OR char_length(partner_id) BETWEEN 1 AND 41),
  host           text NOT NULL DEFAULT '' CHECK (char_length(host) <= 120),
  fee_bps        integer NULL CHECK (fee_bps IS NULL OR fee_bps BETWEEN 0 AND 10000),
  native_raw     numeric(78, 0) NULL CHECK (native_raw IS NULL OR native_raw >= 0),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, fingerprint, wallet)
);
CREATE INDEX IF NOT EXISTS widget_swap_builds_created_idx ON public.widget_swap_builds (created_at);

ALTER TABLE public.finance_import_swap_fees ADD COLUMN IF NOT EXISTS landed_fingerprint text NULL;
ALTER TABLE public.finance_import_swap_fees ADD COLUMN IF NOT EXISTS swap_source text NULL;
ALTER TABLE public.finance_import_swap_fees ADD COLUMN IF NOT EXISTS widget_host text NULL;
ALTER TABLE public.finance_import_swap_fees ADD COLUMN IF NOT EXISTS widget_build_id bigint NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_import_swap_fees_widget_check') THEN
    ALTER TABLE public.finance_import_swap_fees
      ADD CONSTRAINT finance_import_swap_fees_widget_check
      CHECK ((swap_source IS NULL OR swap_source = 'widget')
         AND (widget_host IS NULL OR char_length(widget_host) <= 120)
         AND (landed_fingerprint IS NULL OR char_length(landed_fingerprint) BETWEEN 16 AND 128)) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.widget_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_swap_builds ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.widget_usage_daily, public.widget_swap_builds FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.widget_usage_daily, public.widget_swap_builds FROM authenticated;
  END IF;
END $$;

COMMENT ON TABLE public.widget_usage_daily IS 'Swap widget requests per UTC day, chain, partner, embedding website (hostname only) and event. No IPs, wallets or visitor ids. API only.';
COMMENT ON TABLE public.widget_swap_builds IS 'Every swap the API built for the swap widget: fingerprint (same as import_swap_fingerprints), wallet (only to match the landed swap), partner, website. Unmatched rows are deleted after 30 days. API only.';
COMMENT ON COLUMN public.finance_import_swap_fees.landed_fingerprint IS 'Fingerprint of the landed transaction (importSwapFingerprint.js), kept only when the row wallet is the landed wallet. Matches widget builds.';
COMMENT ON COLUMN public.finance_import_swap_fees.swap_source IS 'widget when the landed swap matches a widget build (fingerprint + landed wallet); null otherwise.';
COMMENT ON COLUMN public.finance_import_swap_fees.widget_host IS 'The embedding website of the matching widget build.';

COMMIT;

-- Part 2 (its own transaction; the Supabase SQL editor wraps every run in one, so no CONCURRENTLY). Idempotent.
BEGIN;

ALTER TABLE public.finance_import_swap_fees VALIDATE CONSTRAINT finance_import_swap_fees_widget_check;

CREATE INDEX IF NOT EXISTS finance_import_swap_fees_widget_idx
  ON public.finance_import_swap_fees (chain_id, occurred_at) WHERE swap_source = 'widget';

CREATE INDEX IF NOT EXISTS finance_import_swap_fees_widget_build_idx
  ON public.finance_import_swap_fees (widget_build_id) WHERE widget_build_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS evm_gen8_fee_accruals_widget_idx
  ON public.evm_gen8_fee_accruals (chain_id, hook_address, block_time)
  WHERE kind = 'trade' AND lower(coalesce(referrer, '')) = '0x000000000000000000000000000000006d777a77';

COMMIT;
