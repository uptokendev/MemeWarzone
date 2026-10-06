BEGIN;

-- Finance read speed (founder 2026-10-06: "the financial system is very slow, it barely loads").
--
-- 1. finance_snapshots: the chain-derived finance read models, stored by the API. Each row holds the
--    finished JSON of one read: fee routing per chain and period (balances, wiring, operator cap),
--    payouts per chain and period (vault balances, creator fee vaults and claimables, arena pools,
--    operator fill), the indexer LP-fee read per chain, the UP vote fee-receiver check per chain and
--    the spot prices. `npm run cron:finance-snapshots` (Coolify scheduled task on the API service)
--    rebuilds them every 5 minutes; the finance pages read the row instead of calling RPCs, Binance
--    and the indexer on every request. A row is replaced in place (one row per key). `error` keeps
--    the last failed rebuild while the last good payload stays readable.
-- 2. finance_price_hourly: Binance hourly closes (SOLUSDT, BNBUSDT, ETHUSDT) used to value an event
--    at the hour it happened. A closed hour never changes, so each hour is fetched once and kept.
-- 3. finance_fx_daily: ECB euro reference rates (USD per 1 EUR) per business day. The ECB file only
--    holds the last 90 business days; keeping the rows builds the history as days pass.
--
-- Nothing here holds or moves funds. RLS on with no policies: only the API (table owner) reads and
-- writes; anon and authenticated get no access.
--
-- Idempotent: safe to run twice. Plain CREATE INDEX (the tables are new and small).

CREATE TABLE IF NOT EXISTS public.finance_snapshots (
  key        text PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 200),
  kind       text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 60),
  payload    jsonb NULL,
  built_at   timestamptz NULL,
  build_ms   integer NULL CHECK (build_ms IS NULL OR build_ms >= 0),
  error      text NULL,
  error_at   timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_snapshots_kind_idx ON public.finance_snapshots (kind);

CREATE TABLE IF NOT EXISTS public.finance_price_hourly (
  asset      text NOT NULL CHECK (asset IN ('SOL', 'BNB', 'ETH')),
  hour       timestamptz NOT NULL CHECK (date_trunc('hour', hour) = hour),
  close_usd  numeric NOT NULL CHECK (close_usd > 0),
  source     text NOT NULL DEFAULT 'binance-1h',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset, hour)
);

CREATE TABLE IF NOT EXISTS public.finance_fx_daily (
  day         date NOT NULL,
  pair        text NOT NULL DEFAULT 'USD_PER_EUR' CHECK (pair = 'USD_PER_EUR'),
  rate        numeric NOT NULL CHECK (rate > 0 AND rate < 10),
  source      text NOT NULL DEFAULT 'ecb-eurofxref',
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pair, day)
);

ALTER TABLE public.finance_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_price_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_fx_daily ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.finance_snapshots, public.finance_price_hourly, public.finance_fx_daily FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.finance_snapshots, public.finance_price_hourly, public.finance_fx_daily FROM authenticated;
  END IF;
END $$;

COMMENT ON TABLE public.finance_snapshots IS 'Chain-derived finance read models (fee routing, payouts, LP read, prices), rebuilt every 5 min by cron:finance-snapshots. API only.';
COMMENT ON TABLE public.finance_price_hourly IS 'Binance 1h closes for event-time USD valuation; a closed hour never changes. API only.';
COMMENT ON TABLE public.finance_fx_daily IS 'ECB USD per EUR reference rates per business day. API only.';

COMMIT;
