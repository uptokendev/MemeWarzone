begin;

alter table public.quote_assets
  add column if not exists provider_asset_id text,
  add column if not exists category text not null default 'ECOSYSTEM',
  add column if not exists tags jsonb not null default '[]'::jsonb;

alter table public.quote_asset_deployments
  add column if not exists chain_family text,
  add column if not exists decimals integer,
  add column if not exists canonical_status text not null default 'CANDIDATE',
  add column if not exists native_wrapped_status text not null default 'NONE',
  add column if not exists transferability_status text not null default 'PENDING',
  add column if not exists acquisition_route_status text not null default 'PENDING',
  add column if not exists price_authority_status text not null default 'PENDING',
  add column if not exists lp_venue_status text not null default 'PENDING',
  add column if not exists catalog_state text not null default 'CANDIDATE',
  add column if not exists evidence_sources jsonb not null default '[]'::jsonb,
  add column if not exists last_identity_verified_at timestamptz,
  add column if not exists last_security_verified_at timestamptz,
  add column if not exists last_route_verified_at timestamptz,
  add column if not exists last_price_verified_at timestamptz,
  add column if not exists last_lp_verified_at timestamptz;

alter table public.quote_assets drop constraint if exists quote_assets_asset_class_check;
alter table public.quote_assets add constraint quote_assets_asset_class_check check (
  asset_class in (
    'NATIVE','STABLECOIN','PUBLIC_RWA','PRE_IPO_RWA','COMMODITY','CRYPTO',
    'LEVERAGED_OR_YIELD','COLLECTIBLE','PROVIDER_RWA','MWZ_NATIVE','COMMUNITY','OTHER'
  )
);

alter table public.quote_assets add constraint quote_assets_category_check check (
  category in ('CORE','STABLES_CURRENCIES','STOCKS','ETFS','RWA_COMMODITIES','ECOSYSTEM','MEMEWARZONE','COMMUNITY')
) not valid;
alter table public.quote_assets validate constraint quote_assets_category_check;

alter table public.quote_asset_deployments add constraint quote_asset_deployments_catalog_state_check check (
  catalog_state in ('CANDIDATE','IDENTITY_VERIFIED','ROUTE_PENDING','PRICE_PENDING','LP_PENDING','ACTIVE','SUSPENDED','REJECTED')
) not valid;
alter table public.quote_asset_deployments validate constraint quote_asset_deployments_catalog_state_check;

alter table public.quote_asset_deployments add constraint quote_asset_deployments_transferability_check check (
  transferability_status in ('PENDING','VERIFIED','RESTRICTED','NON_TRANSFERABLE','REJECTED')
) not valid;
alter table public.quote_asset_deployments validate constraint quote_asset_deployments_transferability_check;

alter table public.quote_asset_deployments add constraint quote_asset_deployments_route_check check (
  acquisition_route_status in ('PENDING','VERIFIED','UNAVAILABLE','REJECTED')
) not valid;
alter table public.quote_asset_deployments validate constraint quote_asset_deployments_route_check;

alter table public.quote_asset_deployments add constraint quote_asset_deployments_price_check check (
  price_authority_status in ('PENDING','VERIFIED','UNAVAILABLE','STALE','REJECTED')
) not valid;
alter table public.quote_asset_deployments validate constraint quote_asset_deployments_price_check;

alter table public.quote_asset_deployments add constraint quote_asset_deployments_lp_check check (
  lp_venue_status in ('PENDING','VERIFIED','UNAVAILABLE','REJECTED')
) not valid;
alter table public.quote_asset_deployments validate constraint quote_asset_deployments_lp_check;

-- Preserve #216's exact BASIC IDs while projecting them into the richer taxonomy.
update public.quote_assets
set category = case when asset_key = 'sol-native' then 'CORE' else 'STABLES_CURRENCIES' end,
    tags = case when asset_key = 'sol-native' then '["CORE"]'::jsonb else '["STABLE","BASIC"]'::jsonb end
where id in (
  'a2100000-0000-4000-8000-000000000101'::uuid,
  'a2100000-0000-4000-8000-000000000102'::uuid
);

update public.quote_asset_deployments
set chain_family = 'SOLANA',
    decimals = case when id = 'a2100000-0000-4000-8000-000000000201'::uuid then 9 else 6 end,
    canonical_status = 'IDENTITY_VERIFIED',
    native_wrapped_status = case when id = 'a2100000-0000-4000-8000-000000000201'::uuid then 'NATIVE_WRAPPED_PATH' else 'CANONICAL' end,
    transferability_status = 'VERIFIED',
    acquisition_route_status = 'VERIFIED',
    price_authority_status = 'VERIFIED',
    lp_venue_status = 'VERIFIED',
    catalog_state = 'ACTIVE',
    last_identity_verified_at = coalesce(last_identity_verified_at, last_scan_at, now()),
    last_security_verified_at = coalesce(last_security_verified_at, last_scan_at, now()),
    last_route_verified_at = coalesce(last_route_verified_at, last_scan_at, now()),
    last_price_verified_at = coalesce(last_price_verified_at, last_scan_at, now()),
    last_lp_verified_at = coalesce(last_lp_verified_at, last_scan_at, now())
where id in (
  'a2100000-0000-4000-8000-000000000201'::uuid,
  'a2100000-0000-4000-8000-000000000202'::uuid
);

comment on column public.quote_asset_deployments.catalog_state is
  'Launch catalog lifecycle. ACTIVE is required for new generic graduation eligibility; candidate/pending/rejected states fail closed.';
comment on column public.quote_assets.tags is
  'Non-authoritative discovery tags such as TRENDING. Tags never grant graduation eligibility.';

commit;
