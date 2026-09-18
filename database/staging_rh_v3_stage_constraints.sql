-- TESTNET / STAGING ONLY (vrnsbguutnwgtekcexls).
-- Never run on production (ellkfgoxnzykxqybajtn) without a separate decision.
--
-- Staging's public schema was copied from production, which predates
-- db/migrations/202608270001_robinhood_v3_market_continuity.sql. So the
-- Robinhood DEX_* market stages are still rejected here:
--
--   new row for relation "campaign_market_state"
--   violates check constraint "campaign_market_state_stage_valid"
--
-- Effect on 46630: the V3 pool indexer finds the graduated campaign, fails
-- verification, then cannot even record the failure because writing
-- DEX_DEGRADED violates the old constraint. That write throws out of the error
-- handler, so the row stays GRADUATING with last_error null, dex_pools is never
-- written, and Token Details shows Liquidity as "-".
--
-- This applies only the constraint half of that migration. The view rebuild in
-- the same file is deliberately NOT included, because RH market_trades_v
-- identity is handled separately.

begin;

-- 1. Show what is actually installed before changing anything, including the
--    staging-only campaign_market_state_graduation_order constraint that has no
--    counterpart in db/migrations.
select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid in (
         'public.campaigns'::regclass,
         'public.campaign_market_state'::regclass,
         'public.market_stats'::regclass,
         'public.dex_trades'::regclass
       )
   and contype = 'c'
 order by table_name, conname;

-- 2. Allow the Robinhood DEX lifecycle stages. Additive: every previously
--    permitted value is preserved, so BNB/Topaz semantics are unchanged.
alter table public.campaigns drop constraint if exists campaigns_market_stage_valid;
alter table public.campaigns add constraint campaigns_market_stage_valid check (
  market_stage = any(array[
    'BONDING','GRADUATING',
    'TOPAZ_PENDING','TOPAZ_ACTIVE','TOPAZ_DEGRADED',
    'DEX_PENDING','DEX_ACTIVE','DEX_DEGRADED',
    'PAUSED','UNSUPPORTED'
  ]::text[])
);

alter table public.campaign_market_state drop constraint if exists campaign_market_state_stage_valid;
alter table public.campaign_market_state add constraint campaign_market_state_stage_valid check (
  market_stage = any(array[
    'BONDING','GRADUATING',
    'TOPAZ_PENDING','TOPAZ_ACTIVE','TOPAZ_DEGRADED',
    'DEX_PENDING','DEX_ACTIVE','DEX_DEGRADED',
    'PAUSED','UNSUPPORTED'
  ]::text[])
);

-- 2b. market_stats is the third table carrying market_stage, and the one
--     Token Details reads market cap, liquidity and the 5m/1h/4h/24h tiles from.
--     Rejecting DEX_ACTIVE leaves the row missing entirely, so the page
--     recomputes those numbers from raw trades and disagrees between renders:
--
--       new row for relation "market_stats"
--       violates check constraint "market_stats_stage_valid"
alter table public.market_stats drop constraint if exists market_stats_stage_valid;
alter table public.market_stats add constraint market_stats_stage_valid check (
  market_stage = any(array[
    'BONDING','GRADUATING',
    'TOPAZ_PENDING','TOPAZ_ACTIVE','TOPAZ_DEGRADED',
    'DEX_PENDING','DEX_ACTIVE','DEX_DEGRADED',
    'PAUSED','UNSUPPORTED'
  ]::text[])
);

-- 3. robinhood_v3 swaps must be a permitted dex_trades origin, or post-grad
--    volume cannot be recorded even once the pool verifies.
alter table public.dex_trades drop constraint if exists dex_trades_origin_valid;
alter table public.dex_trades add constraint dex_trades_origin_valid check (
  origin = any(array['memewarzone','topaz','robinhood_v3','aggregator','unknown']::text[])
);

commit;

-- 4. Confirm the new definitions.
select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conname in (
         'campaigns_market_stage_valid',
         'campaign_market_state_stage_valid',
   'market_stats_stage_valid',
         'dex_trades_origin_valid',
         'campaign_market_state_graduation_order'
       )
 order by table_name, conname;
