-- TESTNET / STAGING ONLY (vrnsbguutnwgtekcexls). READ ONLY - changes nothing.
--
-- Staging's schema is a mix: market_pairs (2026-09-02) is present while the
-- 2026-08-27 stage constraint was not, so migration order cannot be assumed.
-- The V3 pool indexer writes dex_pools with the full generic-market column set;
-- if any of those columns is missing the insert fails and the pool degrades
-- again for a completely different reason.
--
-- Run this before redeploying the indexer. Every row must report present = true.

select
  required.column_name,
  (c.column_name is not null) as present
from (values
    ('chain_id'),
    ('pair_address'),
    ('campaign_address'),
    ('token_address'),
    ('wrapped_native_address'),
    ('router_address'),
    ('factory_address'),
    ('factory_generation'),
    ('token0_address'),
    ('token1_address'),
    ('stable'),
    ('fee_bps'),
    ('fee_tier'),
    ('graduation_block'),
    ('support_enabled'),
    ('indexing_enabled'),
    ('reserve_token_raw'),
    ('reserve_native_raw'),
    ('base_token_address'),
    ('quote_token_address'),
    ('base_decimals'),
    ('quote_decimals'),
    ('quote_asset_type'),
    ('market_role'),
    ('reserve_base_raw'),
    ('reserve_quote_raw'),
    ('oracle_feed_address'),
    ('verified'),
    ('trading_enabled'),
    ('last_verified_at'),
    ('updated_at')
  ) as required(column_name)
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = 'dex_pools'
   and c.column_name = required.column_name
 order by present asc, required.column_name;

-- Anything reporting present = false is supplied by one of:
--   db/migrations/20260902_000001_robinhood_generic_market_pairs.sql
--   db/migrations/20260902_000002_robinhood_quote_native_compatibility.sql
--   db/migrations/202609080003_bnb_postgrad_quote_identity.sql
-- Apply the missing file(s) to staging only.
