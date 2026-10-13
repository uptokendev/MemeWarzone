-- Gen-8 indexer integration test only (throwaway Postgres). Applied after the DBC test schema, the market-continuity
-- foundation (202607290001) and the gen-5 indexing migration (20260930_000001); brings the tables the gen-8 writers
-- touch to the column set production has (as listed from db/migrations), then market_trades_v (20260921_000002) and
-- the gen-8 migration run on top.
alter table public.campaigns drop constraint if exists campaigns_market_stage_valid;
alter table public.campaigns add constraint campaigns_market_stage_valid check (market_stage = any(array[
  'BONDING','GRADUATING','TOPAZ_PENDING','TOPAZ_ACTIVE','TOPAZ_DEGRADED','DEX_PENDING','DEX_ACTIVE','DEX_DEGRADED','PAUSED','UNSUPPORTED']::text[]));
alter table public.campaign_market_state drop constraint if exists campaign_market_state_stage_valid;

alter table public.curve_trades add column if not exists sold_tokens_after_raw numeric;

alter table public.token_stats add column if not exists sold_tokens numeric;
alter table public.token_stats add column if not exists marketcap_bnb numeric;
alter table public.token_stats add column if not exists vol_24h_bnb numeric;

alter table public.token_candles
  add column if not exists price_o numeric, add column if not exists price_h numeric,
  add column if not exists price_l numeric, add column if not exists price_c numeric,
  add column if not exists mcap_o numeric, add column if not exists mcap_h numeric,
  add column if not exists mcap_l numeric, add column if not exists mcap_c numeric,
  add column if not exists canonical_version smallint, add column if not exists canonical_updated_at timestamptz;

alter table public.dex_trades
  add column if not exists base_amount_raw text, add column if not exists quote_amount_raw text,
  add column if not exists quote_asset_type text, add column if not exists quote_token_address text,
  add column if not exists volume_usd numeric, add column if not exists reference_price_usd numeric,
  add column if not exists reference_price_updated_at timestamptz;
alter table public.dex_trades drop constraint if exists dex_trades_origin_valid;
alter table public.dex_trades add constraint dex_trades_origin_valid check (origin = any(array['memewarzone','topaz','robinhood_v3','aggregator','unknown']::text[]));

alter table public.market_stats add column if not exists quote_asset_type text;

create table if not exists public.reward_alerts (
  id uuid primary key default gen_random_uuid(),
  severity text not null default 'info',
  reward_type text,
  title text not null,
  message text not null default '',
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved', 'ignored')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text
);

create table if not exists public.token_holder_balances (
  chain_id integer not null, token_address text not null, wallet text not null,
  balance_raw numeric(78,0) not null default 0, updated_at timestamptz not null default now(),
  primary key (chain_id, token_address, wallet)
);
create table if not exists public.token_holder_sync (
  chain_id integer not null, token_address text not null, campaign_address text not null,
  last_block bigint not null default 0, saw_mint boolean not null default false, updated_at timestamptz not null default now(),
  primary key (chain_id, token_address)
);
create table if not exists public.campaign_activity (
  chain_id integer not null, campaign_address text not null, last_activity_at timestamptz, updated_at timestamptz not null default now(),
  primary key (chain_id, campaign_address)
);

-- Supabase roles the migrations grant to / revoke from.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
end $$;
