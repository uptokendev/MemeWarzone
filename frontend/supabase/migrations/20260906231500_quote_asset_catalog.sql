begin;

create extension if not exists pgcrypto;

create table if not exists public.quote_asset_providers (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null unique,
  display_name text not null,
  authority_mode text not null check (authority_mode in ('GENERIC_POLICY','ROBINHOOD_STOCK_REGISTRY')),
  provider_class text not null,
  admin_state text not null default 'enabled' check (admin_state in ('enabled','disabled')),
  state_version bigint not null default 1 check (state_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quote_assets (
  id uuid primary key default gen_random_uuid(),
  provider_id uuid not null references public.quote_asset_providers(id),
  asset_key text not null,
  asset_class text not null check (asset_class in ('NATIVE','STABLECOIN','PROVIDER_RWA','MWZ_NATIVE','COMMUNITY')),
  symbol text,
  display_name text,
  logo_url text,
  admin_state text not null default 'enabled' check (admin_state in ('enabled','disabled')),
  state_version bigint not null default 1 check (state_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, asset_key)
);

create table if not exists public.quote_asset_deployments (
  id uuid primary key default gen_random_uuid(),
  quote_asset_id uuid not null references public.quote_assets(id),
  provider_id uuid not null references public.quote_asset_providers(id),
  chain_id text not null,
  identity_kind text not null check (identity_kind in ('EVM_ADDRESS','SOLANA_MINT','NATIVE')),
  contract_address_or_mint text not null,
  identity_key text not null,
  identity_status text not null default 'pending' check (identity_status in ('pending','verified','review','rejected','stale')),
  security_status text not null default 'pending' check (security_status in ('pending','verified','review','rejected','stale')),
  market_health_status text not null default 'pending' check (market_health_status in ('pending','healthy','review','unhealthy','stale')),
  existing_market_support boolean not null default false,
  admin_state text not null default 'enabled' check (admin_state in ('enabled','disabled')),
  state_version bigint not null default 1 check (state_version > 0),
  last_scan_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_id, chain_id, identity_key),
  unique (quote_asset_id, chain_id, identity_key)
);

create table if not exists public.quote_asset_policy_versions (
  id uuid primary key default gen_random_uuid(),
  quote_asset_id uuid references public.quote_assets(id),
  provider_id uuid not null references public.quote_asset_providers(id),
  policy_key text not null,
  version integer not null check (version > 0),
  policy_status text not null default 'draft' check (policy_status in ('draft','active','retired')),
  basic_approved boolean not null default false,
  new_graduation_enabled boolean not null default false,
  require_identity_verified boolean not null default true,
  require_security_verified boolean not null default true,
  require_market_healthy boolean not null default true,
  policy_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (provider_id, policy_key, version)
);

create unique index if not exists quote_asset_policy_one_active_per_asset
  on public.quote_asset_policy_versions(quote_asset_id)
  where quote_asset_id is not null and policy_status = 'active';

create table if not exists public.quote_asset_scan_history (
  id uuid primary key default gen_random_uuid(),
  deployment_id uuid not null references public.quote_asset_deployments(id),
  provider_id uuid not null references public.quote_asset_providers(id),
  state_version bigint not null,
  scan_kind text not null,
  identity_status text,
  security_status text,
  market_health_status text,
  evidence jsonb not null default '{}'::jsonb,
  scanner_identity text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.quote_asset_decision_history (
  id uuid primary key default gen_random_uuid(),
  deployment_id uuid not null references public.quote_asset_deployments(id),
  provider_id uuid not null references public.quote_asset_providers(id),
  policy_version_id uuid references public.quote_asset_policy_versions(id),
  state_version bigint not null,
  decision text not null check (decision in ('eligible','ineligible','existing_market_only','disabled','review')),
  reason text not null,
  decision_snapshot jsonb not null default '{}'::jsonb,
  actor_identity text not null,
  created_at timestamptz not null default now()
);

create or replace function public.quote_catalog_history_append_only()
returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;

drop trigger if exists quote_asset_scan_history_append_only on public.quote_asset_scan_history;
create trigger quote_asset_scan_history_append_only
before update or delete on public.quote_asset_scan_history
for each row execute function public.quote_catalog_history_append_only();

drop trigger if exists quote_asset_decision_history_append_only on public.quote_asset_decision_history;
create trigger quote_asset_decision_history_append_only
before update or delete on public.quote_asset_decision_history
for each row execute function public.quote_catalog_history_append_only();

create index if not exists quote_asset_deployments_chain_idx on public.quote_asset_deployments(chain_id, admin_state);
create index if not exists quote_asset_scan_history_deployment_idx on public.quote_asset_scan_history(deployment_id, created_at desc);
create index if not exists quote_asset_decision_history_deployment_idx on public.quote_asset_decision_history(deployment_id, created_at desc);

insert into public.quote_asset_providers (provider_key, display_name, authority_mode, provider_class)
values
  ('robinhood-stock-token', 'Robinhood Stock Token Registry', 'ROBINHOOD_STOCK_REGISTRY', 'PROVIDER_RWA'),
  ('robinhood-basic', 'Robinhood BASIC Quote Assets', 'GENERIC_POLICY', 'BASIC')
on conflict (provider_key) do nothing;

comment on table public.quote_asset_deployments is
  'Canonical quote identity is provider + chain + exact contract/mint identity_key. Symbol/name/logo are display metadata only.';
comment on table public.quote_asset_policy_versions is
  'Versioned server-side quote eligibility policy. BASIC assets require an explicitly active basic_approved policy.';
comment on table public.quote_asset_scan_history is 'Append-only quote asset scan evidence.';
comment on table public.quote_asset_decision_history is 'Append-only server-side quote eligibility decision history.';

commit;
