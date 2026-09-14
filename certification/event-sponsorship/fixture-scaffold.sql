\set ON_ERROR_STOP on

-- Certification-only external fixture scaffold. Production handlers and repository
-- Event Sponsorship migrations remain authoritative; this file supplies only the
-- adjacent runtime tables a disposable PostgreSQL instance needs.

create table if not exists public.auth_nonces (
  chain_id integer not null,
  address text not null,
  nonce text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(chain_id,address,nonce)
);

create table if not exists public.arena_tournaments (
  id uuid primary key,
  chain_id integer not null,
  status text not null default 'open',
  origin text not null default 'normal',
  starts_at timestamptz,
  ends_at timestamptz,
  battle_mode text not null default 'normal',
  competition_generation integer not null default 1,
  contest_scoring_version integer not null default 3
);

create table if not exists public.arena_league_seasons (
  id uuid primary key,
  chain_id integer not null,
  state text not null default 'open',
  active boolean not null default true,
  reset_at timestamptz,
  frozen_at timestamptz,
  quarter_finals_tournament_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sponsorship_price_tiers (
  id uuid primary key,
  code text not null unique,
  active boolean not null default true,
  effective_from timestamptz not null default now(),
  effective_until timestamptz,
  min_qualified_users bigint not null default 0,
  max_qualified_users bigint,
  sort_order integer not null default 1,
  tournament_min_usd_cents numeric(78,0) not null,
  mwl_min_usd_cents numeric(78,0) not null,
  quarterly_min_usd_cents numeric(78,0) not null
);

create table if not exists public.sponsorship_traffic_snapshots (
  id bigserial primary key,
  snapshot_date date not null default current_date,
  rolling_30d_qualified_users bigint not null default 0,
  active_tier_id uuid references public.sponsorship_price_tiers(id),
  recommended_tier_id uuid references public.sponsorship_price_tiers(id),
  created_at timestamptz not null default now()
);

create table if not exists public.sponsorship_price_overrides (
  id bigserial primary key,
  active boolean not null default true,
  starts_at timestamptz,
  ends_at timestamptz,
  event_type text,
  scope_type text not null,
  scope_id text,
  chain_id integer,
  min_usd_cents numeric(78,0) not null,
  created_at timestamptz not null default now()
);

insert into public.sponsorship_price_tiers(
  id,code,active,effective_from,min_qualified_users,max_qualified_users,sort_order,
  tournament_min_usd_cents,mwl_min_usd_cents,quarterly_min_usd_cents
) values (
  '70000000-0000-0000-0000-000000000001','CERT',true,now()-interval '1 hour',0,null,1,1,1,1
) on conflict(id) do nothing;

insert into public.sponsorship_traffic_snapshots(
  snapshot_date,rolling_30d_qualified_users,active_tier_id,recommended_tier_id
) values (
  current_date,0,'70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000001'
);
