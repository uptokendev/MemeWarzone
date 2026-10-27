-- Swap widget usage and revenue tracking (2026-10-23). PRODUCTION, Supabase SQL editor (project ellkfgoxnzykxqybajtn).
-- Same statements as db/migrations/20261023_000020_widget_analytics.sql (the part from BEGIN to the end is identical).
--
-- What it does: creates widget_usage_daily (daily counts per chain, partner, embedding website and event; no IPs, no
-- wallets, no visitor ids) and widget_swap_builds (every swap the API built for the widget, with the same fingerprint
-- the partner attribution records and the wallet it was built for, only to match the landed swap; unmatched builds
-- are deleted by the API after 30 days), and adds four nullable columns to finance_import_swap_fees: landed_fingerprint,
-- swap_source ('widget' or null), widget_host, widget_build_id. Every existing row keeps its values (the new columns
-- are null, no default, so no row is rewritten); no amount column, partner row, payout or fingerprint changes. RLS on,
-- no policies, anon and authenticated revoked, like the other import fee tables. Nothing is dropped. Idempotent: safe
-- to run twice.
--
-- Order: the API that carries api/lib/widgetTracking.js can be deployed before or after this; without these tables it
-- counts nothing and the fee scanner marks nothing (both skip quietly). Widget swaps are marked from the moment both
-- the SQL and the API are live (the scanner looks back 7 days on every run).
--
-- How: three blocks, each starting with a ==== line below. In the Supabase SQL editor paste ONE block at a time
-- (from its ==== line down to the next ==== line) and Run it. Every block is idempotent: running it twice is harmless.
--   PART 1: tables, columns, the CHECK (added NOT VALID: short lock, no table scan).
--   PART 2: validates the CHECK and builds three indexes (plain CREATE INDEX: the editor runs every paste inside a
--           transaction, so CONCURRENTLY is not possible there; these tables are small, the lock lasts well under a second).
--   CHECK:  read only, shows the result.
-- With psql the whole file also runs in one go: psql -v ON_ERROR_STOP=1 -f database/prod_apply_widget_analytics.sql

-- ======================== PART 1: paste from here down to the next ==== line, then Run ========================
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

-- ======================== PART 2: paste from here down to the next ==== line, then Run ========================
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

-- ======================== CHECK: paste from here to the end, then Run (read only) ========================
-- One query (the Supabase editor only shows the last result of a multi-statement run). Expect 11 rows: check true,
-- four columns, three indexes true, 0 marked rows on the first run, two tables.
select 'table' as kind, table_name as name, 'exists' as value
  from information_schema.tables
 where table_schema = 'public' and table_name in ('widget_usage_daily', 'widget_swap_builds')
union all
select 'column', column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'finance_import_swap_fees'
   and column_name in ('landed_fingerprint', 'swap_source', 'widget_host', 'widget_build_id')
union all
select 'check', conname, convalidated::text
  from pg_constraint where conname = 'finance_import_swap_fees_widget_check'
union all
select 'index', c.relname, i.indisvalid::text
  from pg_index i join pg_class c on c.oid = i.indexrelid
 where c.relname in ('finance_import_swap_fees_widget_idx', 'finance_import_swap_fees_widget_build_idx', 'evm_gen8_fee_accruals_widget_idx')
union all
select 'marked rows', 'widget_marked_fee_rows', count(*)::text
  from public.finance_import_swap_fees where swap_source is not null
order by 1, 2;
