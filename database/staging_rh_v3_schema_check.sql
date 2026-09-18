-- TESTNET / STAGING ONLY (vrnsbguutnwgtekcexls). READ ONLY - changes nothing.
--
-- Staging's schema is a mix: market_pairs (2026-09-02) is present while the
-- 2026-08-27 stage constraint was not, so migration order cannot be assumed.
-- V3 pool discovery writes dex_pools AND market_pairs in one transaction; a
-- column missing from either makes the insert fail and degrades the pool again
-- for an unrelated reason.
--
-- Column lists mirror the two inserts in
-- realtime-indexer/src/robinhoodV3PoolIndexer.ts exactly. fee_tier, verified,
-- trading_enabled and last_verified_at belong to market_pairs, NOT dex_pools.
--
-- Run before redeploying the indexer. Every row must report present = true.

select
  required.table_name,
  required.column_name,
  (c.column_name is not null) as present
from (values
    -- insert into public.dex_pools(...)
    ('dex_pools','chain_id'),
    ('dex_pools','pair_address'),
    ('dex_pools','campaign_address'),
    ('dex_pools','token_address'),
    ('dex_pools','wrapped_native_address'),
    ('dex_pools','router_address'),
    ('dex_pools','factory_address'),
    ('dex_pools','factory_generation'),
    ('dex_pools','token0_address'),
    ('dex_pools','token1_address'),
    ('dex_pools','stable'),
    ('dex_pools','fee_bps'),
    ('dex_pools','graduation_block'),
    ('dex_pools','support_enabled'),
    ('dex_pools','indexing_enabled'),
    ('dex_pools','reserve_token_raw'),
    ('dex_pools','reserve_native_raw'),
    ('dex_pools','base_token_address'),
    ('dex_pools','quote_token_address'),
    ('dex_pools','base_decimals'),
    ('dex_pools','quote_decimals'),
    ('dex_pools','quote_asset_type'),
    ('dex_pools','market_role'),
    ('dex_pools','reserve_base_raw'),
    ('dex_pools','reserve_quote_raw'),
    ('dex_pools','oracle_feed_address'),
    ('dex_pools','updated_at'),
    -- insert into public.market_pairs(...)
    ('market_pairs','chain_id'),
    ('market_pairs','campaign_address'),
    ('market_pairs','pool_address'),
    ('market_pairs','base_token_address'),
    ('market_pairs','quote_token_address'),
    ('market_pairs','base_decimals'),
    ('market_pairs','quote_decimals'),
    ('market_pairs','quote_asset_type'),
    ('market_pairs','market_role'),
    ('market_pairs','venue'),
    ('market_pairs','fee_tier'),
    ('market_pairs','router_address'),
    ('market_pairs','factory_address'),
    ('market_pairs','verified'),
    ('market_pairs','trading_enabled'),
    ('market_pairs','indexing_enabled'),
    ('market_pairs','oracle_feed_address'),
    ('market_pairs','reserve_base_raw'),
    ('market_pairs','reserve_quote_raw'),
    ('market_pairs','last_verified_at'),
    ('market_pairs','updated_at'),
    -- canonical series written by the V3 candle upsert; when these are missing
    -- the chart falls back to trade fill prices instead of pool spot
    ('token_candles','price_o'),
    ('token_candles','price_h'),
    ('token_candles','price_l'),
    ('token_candles','price_c'),
    ('token_candles','mcap_o'),
    ('token_candles','mcap_h'),
    ('token_candles','mcap_l'),
    ('token_candles','mcap_c'),
    ('token_candles','canonical_updated_at')
  ) as required(table_name, column_name)
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = required.table_name
   and c.column_name = required.column_name
 order by present asc, required.table_name, required.column_name;

-- Anything reporting present = false is supplied by one of:
--   db/migrations/20260902_000001_robinhood_generic_market_pairs.sql
--   db/migrations/20260902_000002_robinhood_quote_native_compatibility.sql
--   db/migrations/202609080003_bnb_postgrad_quote_identity.sql
-- Apply the missing file(s) to staging only.
