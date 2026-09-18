-- TESTNET / STAGING ONLY (vrnsbguutnwgtekcexls). READ ONLY - changes nothing.
--
-- Token Details reads market cap, liquidity and the 5m/1h/4h/24h tiles from
-- public.market_stats. /api/token/<c>/market-summary returns only stage flags
-- for RH5661, which means that row does not exist, so the page recomputes those
-- numbers from raw trades and disagrees with itself between renders.
--
-- BNB works because topazPoolIndexer writes market_stage='TOPAZ_ACTIVE'.
-- Robinhood writes 'DEX_ACTIVE'. Staging has already rejected DEX_* on two
-- other tables via constraints that are absent from db/migrations, so check
-- this table before assuming anything.

-- 1. Does the row exist at all?
select 'row_present' as check_name,
       count(*) as value
  from public.market_stats
 where chain_id = 46630
   and lower(campaign_address) = lower('0xB69E19C4387905170aa17E986aAA3b805dAfe440');

-- 2. What is actually stored for Robinhood campaigns on this chain?
select campaign_address, market_stage, last_price_bnb, market_cap_bnb,
       liquidity_bnb, volume_24h_bnb, supply_basis, updated_at
  from public.market_stats
 where chain_id = 46630
 order by updated_at desc nulls last
 limit 10;

-- 3. Every check constraint on the table, including any that exists only here.
select conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = 'public.market_stats'::regclass
   and contype = 'c'
 order by conname;

-- 4. Which stages does BNB already store successfully? If TOPAZ_ACTIVE rows
--    exist but no DEX_ACTIVE row does, a stage constraint is the cause.
select market_stage, count(*) as rows
  from public.market_stats
 group by market_stage
 order by rows desc;

-- 5. Columns the Robinhood write touches, so a missing one is ruled out too.
select required.column_name,
       (c.column_name is not null) as present
from (values
    ('market_stage'),('last_price_bnb'),('last_price_quote'),('market_cap_bnb'),
    ('liquidity_bnb'),('bonding_reserve_bnb'),
    ('volume_5m_bnb'),('volume_1h_bnb'),('volume_4h_bnb'),('volume_24h_bnb'),
    ('buy_volume_24h_bnb'),('sell_volume_24h_bnb'),
    ('bonding_volume_24h_bnb'),('dex_volume_24h_bnb'),('dex_volume_24h_quote'),
    ('trades_24h'),('buys_24h'),('sells_24h'),
    ('post_burn_total_supply_raw'),('supply_basis'),
    ('quote_token_address'),('quote_asset_type'),
    ('last_trade_block'),('last_trade_at'),('data_lag_seconds'),('updated_at')
  ) as required(column_name)
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = 'market_stats'
   and c.column_name = required.column_name
 order by present asc, required.column_name;
