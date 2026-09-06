-- Robinhood Stock Token graduation registry authority.
-- Founder lock: Robinhood campaigns bond in ETH. This registry only controls
-- NEW post-graduation MEME/Stock Token quote-asset selections.

create extension if not exists pgcrypto;

create table if not exists public.robinhood_stock_token_registry (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null,
  robinhood_asset_uid text,
  contract_address text not null,
  symbol text not null,
  display_name text not null,
  underlying_symbol text,
  canonical boolean not null default false,
  robinhood_status text not null default 'UNKNOWN',
  trading_halted boolean,
  candidate boolean not null default false,
  admin_state text not null default 'default' check (admin_state in ('default','force_enabled','force_disabled')),
  enabled_for_graduation boolean not null default false,
  enabled_for_discovery boolean not null default false,
  enabled_for_trading boolean not null default false,
  automated_health_status text not null default 'stale' check (automated_health_status in ('healthy','review','unhealthy','stale')),
  automated_health_reason text,
  existing_market_support boolean not null default true,
  state_version bigint not null default 1,
  oracle_feed_address text,
  acquisition_pool_address text,
  route_enabled boolean,
  last_canonical_sync_at timestamptz,
  last_health_check_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain_id, contract_address)
);

create unique index if not exists robinhood_stock_token_registry_asset_uid_chain_uidx
  on public.robinhood_stock_token_registry (chain_id, robinhood_asset_uid)
  where robinhood_asset_uid is not null;

create index if not exists robinhood_stock_token_registry_public_idx
  on public.robinhood_stock_token_registry (chain_id, canonical, enabled_for_discovery, enabled_for_graduation);

create table if not exists public.robinhood_stock_token_registry_audit (
  id uuid primary key default gen_random_uuid(),
  registry_id uuid not null references public.robinhood_stock_token_registry(id),
  action text not null,
  reason text,
  operator_identity text not null,
  previous_state jsonb,
  next_state jsonb,
  previous_version bigint,
  next_version bigint,
  created_at timestamptz not null default now()
);

create index if not exists robinhood_stock_token_registry_audit_registry_idx
  on public.robinhood_stock_token_registry_audit (registry_id, created_at desc);

-- Release candidates are database state, not a frontend/source-code allowlist.
-- Candidate status never authorizes graduation by itself.
create table if not exists public.robinhood_stock_token_release_candidates (
  symbol text primary key,
  created_at timestamptz not null default now()
);

insert into public.robinhood_stock_token_release_candidates(symbol)
values ('NVDA'),('SPY'),('QQQ'),('GOOGL'),('AAPL'),('MSFT'),('TSLA'),('COST')
on conflict (symbol) do nothing;

comment on column public.robinhood_stock_token_registry.enabled_for_graduation is
  'Server-derived effective authority for NEW graduations only. Existing MEME/STOCK markets are governed independently by existing_market_support.';
