BEGIN;

-- Swap widget usage and revenue tracking (2026-10-23). Observation only: nothing here changes a swap, a fee, a
-- partner split or a payout. The API writes these rows best effort after it has answered the widget; a missing
-- table only means nothing is counted.
--
-- 1. widget_usage_daily: one counter per UTC day, chain, partner ('' = none), embedding website and event, incremented
--    with one upsert per widget request (frontend/api/lib/widgetTracking.js). host is the hostname of the request's
--    Origin (else Referer), lower case, without "www.", at most 120 characters, '' when the browser sent neither;
--    'other' once a (day, chain) already has more than 500 sites. No IP address, no wallet, no visitor id, no cookie.
--    Events: load (token lookup), quote, build (a swap transaction was handed out), approval (a sell needed an
--    allowance first), bonding_trade (a Solana launchpad bonding trade was authorized for the widget).
-- 2. widget_swap_builds: every swap the API built for the widget (partner or not), with the same fingerprint the
--    partner attribution records (api/lib/importSwapFingerprint.js: Solana sha256(wallet:Jupiter ix data), EVM
--    keccak(to:data:value)) and the wallet the build is for, so the fee ledger can tell which landed swaps came
--    through the widget, wallet-bound like partnersForSwaps. Never written by the app's own /api/imports/swap routes.
--    import_swap_fingerprints and the partner attribution are unchanged.
-- 3. finance_import_swap_fees.swap_source ('widget' or null), widget_host and widget_build_id: set by the fee scanner
--    (api/lib/financeImportSwapFees.js) when a landed fee row's fingerprint and landed wallet match a widget build.
--    No amount column changes.
--
-- RLS on, no policies: API only (same as the other import fee tables); anon and authenticated revoked.
-- Idempotent: safe to run twice. Nothing is dropped or rewritten.

CREATE TABLE IF NOT EXISTS public.widget_usage_daily (
  day         date NOT NULL,
  chain_id    integer NOT NULL CHECK (chain_id IN (101, 56, 4663, 97, 46630)),
  partner_id  text NOT NULL DEFAULT '' CHECK (partner_id = '' OR partner_id ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  host        text NOT NULL DEFAULT '' CHECK (char_length(host) <= 120),
  event       text NOT NULL CHECK (event IN ('load', 'quote', 'build', 'approval', 'bonding_trade')),
  count       bigint NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day, chain_id, partner_id, host, event)
);
-- The 500-site cap counts the distinct hosts of one (day, chain).
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

ALTER TABLE public.finance_import_swap_fees ADD COLUMN IF NOT EXISTS swap_source text NULL;
ALTER TABLE public.finance_import_swap_fees ADD COLUMN IF NOT EXISTS widget_host text NULL;
ALTER TABLE public.finance_import_swap_fees ADD COLUMN IF NOT EXISTS widget_build_id bigint NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_import_swap_fees_widget_check') THEN
    ALTER TABLE public.finance_import_swap_fees
      ADD CONSTRAINT finance_import_swap_fees_widget_check
      CHECK ((swap_source IS NULL OR swap_source = 'widget') AND (widget_host IS NULL OR char_length(widget_host) <= 120));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS finance_import_swap_fees_widget_idx
  ON public.finance_import_swap_fees (chain_id, occurred_at) WHERE swap_source = 'widget';

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
COMMENT ON TABLE public.widget_swap_builds IS 'Every swap the API built for the swap widget: fingerprint (same as import_swap_fingerprints), wallet, partner, website. Matched by the fee scanner. API only.';
COMMENT ON COLUMN public.finance_import_swap_fees.swap_source IS 'widget when the landed swap matches a widget build (fingerprint + landed wallet); null otherwise.';
COMMENT ON COLUMN public.finance_import_swap_fees.widget_host IS 'The embedding website of the matching widget build.';

COMMIT;
