-- RH-S12: shared quote-asset-aware USD valuation for Robinhood markets.
--
-- The quote/base market remains canonical. These fields are derived evidence only:
--   MEME/USD = MEME/QUOTE * QUOTE/USD
-- Stock Token units must never be copied into native/BNB compatibility columns.

BEGIN;

ALTER TABLE IF EXISTS public.dex_trades
  ADD COLUMN IF NOT EXISTS valuation_source text,
  ADD COLUMN IF NOT EXISTS valuation_healthy boolean,
  ADD COLUMN IF NOT EXISTS valuation_error text;

ALTER TABLE IF EXISTS public.market_stats
  ADD COLUMN IF NOT EXISTS last_price_usd numeric,
  ADD COLUMN IF NOT EXISTS market_cap_usd numeric,
  ADD COLUMN IF NOT EXISTS liquidity_usd numeric,
  ADD COLUMN IF NOT EXISTS volume_24h_usd numeric,
  ADD COLUMN IF NOT EXISTS reference_price_usd numeric,
  ADD COLUMN IF NOT EXISTS reference_price_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS valuation_source text,
  ADD COLUMN IF NOT EXISTS valuation_healthy boolean,
  ADD COLUMN IF NOT EXISTS valuation_error text;

ALTER TABLE IF EXISTS public.dex_pools
  ADD COLUMN IF NOT EXISTS price_usd numeric,
  ADD COLUMN IF NOT EXISTS liquidity_usd numeric,
  ADD COLUMN IF NOT EXISTS volume_usd_24h numeric,
  ADD COLUMN IF NOT EXISTS reference_price_usd numeric,
  ADD COLUMN IF NOT EXISTS reference_price_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS valuation_source text,
  ADD COLUMN IF NOT EXISTS valuation_healthy boolean,
  ADD COLUMN IF NOT EXISTS valuation_error text;

ALTER TABLE IF EXISTS public.token_candles
  ADD COLUMN IF NOT EXISTS o_usd numeric,
  ADD COLUMN IF NOT EXISTS h_usd numeric,
  ADD COLUMN IF NOT EXISTS l_usd numeric,
  ADD COLUMN IF NOT EXISTS c_usd numeric,
  ADD COLUMN IF NOT EXISTS volume_usd numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reference_price_usd numeric,
  ADD COLUMN IF NOT EXISTS reference_price_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS valuation_source text,
  ADD COLUMN IF NOT EXISTS valuation_healthy boolean;

COMMENT ON COLUMN public.market_stats.last_price_usd IS
  'Derived normalized MEME/USD. For Stock markets: last_price_quote * approved Stock Token USD oracle.';
COMMENT ON COLUMN public.market_stats.reference_price_usd IS
  'USD price of the registered quote asset used to derive normalized market values.';
COMMENT ON COLUMN public.market_stats.valuation_source IS
  'Authoritative quote-asset USD reference source. Never a display-only exchange fallback.';
COMMENT ON COLUMN public.dex_trades.volume_usd IS
  'Trade quote amount converted with the stored reference_price_usd captured at index time.';
COMMENT ON COLUMN public.token_candles.c_usd IS
  'Normalized USD close; legacy o/h/l/c retain canonical quote-asset price semantics.';

COMMIT;
