begin;

create extension if not exists pgcrypto;

-- Core Warzone Event Sponsorship schema.
-- This intentionally does not create or modify public.sponsorship_applications,
-- which is the separate advertising sponsorship product.

create table if not exists public.sponsor_profiles (
  id uuid primary key default gen_random_uuid(),
  project_name text not null,
  wallet text,
  verified_wallet text,
  status text not null default 'pending'
    check (status in ('pending','under_review','approved','rejected','suspended')),
  founding_sponsor boolean not null default false,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sponsor_profiles_verified_wallet_idx
  on public.sponsor_profiles(verified_wallet)
  where verified_wallet is not null;
create index if not exists sponsor_profiles_status_created_idx
  on public.sponsor_profiles(status, created_at desc);

create table if not exists public.sponsorship_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  event_reference_id text not null,
  chain_id integer not null check (chain_id > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  sponsorship_open boolean not null default false,
  prize_native_raw numeric(78,0) not null default 0 check (prize_native_raw >= 0),
  sponsorship_prize_native_raw numeric(78,0) not null default 0 check (sponsorship_prize_native_raw >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sponsorship_events_window_check check (starts_at is null or ends_at is null or ends_at >= starts_at),
  constraint sponsorship_events_identity_unique unique (event_type, event_reference_id, chain_id)
);

create index if not exists sponsorship_events_open_idx
  on public.sponsorship_events(event_type, chain_id, sponsorship_open, starts_at, ends_at);

create table if not exists public.sponsorship_payment_quotes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.sponsorship_events(id) on delete restrict,
  chain_id integer not null check (chain_id > 0),
  sponsor_profile_id uuid not null references public.sponsor_profiles(id) on delete restrict,
  sponsor_wallet text not null,
  pricing_tier_id uuid,
  pricing_version numeric(78,0) not null check (pricing_version > 0),
  minimum_usd_cents numeric(78,0) not null check (minimum_usd_cents > 0),
  requested_usd_cents numeric(78,0) not null check (requested_usd_cents >= minimum_usd_cents),
  requested_native_raw numeric(78,0) not null check (requested_native_raw > 0),
  minimum_native_raw numeric(78,0) not null check (minimum_native_raw > 0),
  native_usd_reference_micro_cents numeric(78,0) not null check (native_usd_reference_micro_cents > 0),
  oracle_timestamp timestamptz not null,
  expires_at timestamptz not null,
  nonce numeric(78,0) not null check (nonce >= 0),
  solana_payment_id text,
  solana_receipt_pda text,
  solana_payment_status text not null default 'pending'
    check (solana_payment_status in ('pending','submitted','confirming','recovering','verifying','confirmed','failed','expired')),
  solana_operation_key text,
  solana_signature_reference text,
  solana_signature_blockhash text,
  solana_signature_last_valid_block_height bigint,
  solana_submitted_at timestamptz,
  solana_status_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sponsorship_payment_quotes_expiry_check check (expires_at > oracle_timestamp)
);

create index if not exists sponsorship_payment_quotes_event_wallet_idx
  on public.sponsorship_payment_quotes(event_id, chain_id, sponsor_wallet, created_at desc);
create unique index if not exists sponsorship_payment_quotes_event_nonce_uidx
  on public.sponsorship_payment_quotes(event_id, chain_id, nonce);

create table if not exists public.event_sponsorships (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.sponsorship_events(id) on delete restrict,
  sponsor_profile_id uuid not null references public.sponsor_profiles(id) on delete restrict,
  pricing_tier_id uuid,
  quote_id uuid not null unique references public.sponsorship_payment_quotes(id) on delete restrict,
  status text not null default 'pending_payment'
    check (status in ('inactive','pending_payment','active','cancelled_before_payment','operator_policy_required','completed')),
  gross_native_raw numeric(78,0) not null default 0 check (gross_native_raw >= 0),
  prize_native_raw numeric(78,0) not null default 0 check (prize_native_raw >= 0),
  marketing_native_raw numeric(78,0) not null default 0 check (marketing_native_raw >= 0),
  protocol_native_raw numeric(78,0) not null default 0 check (protocol_native_raw >= 0),
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_sponsorships_conserves_native check (
    prize_native_raw + marketing_native_raw + protocol_native_raw = gross_native_raw
  )
);

create index if not exists event_sponsorships_event_status_idx
  on public.event_sponsorships(event_id, status, created_at asc);

create table if not exists public.sponsorship_payments (
  id uuid primary key default gen_random_uuid(),
  event_sponsorship_id uuid not null references public.event_sponsorships(id) on delete restrict,
  quote_id uuid not null references public.sponsorship_payment_quotes(id) on delete restrict,
  chain_id integer not null check (chain_id > 0),
  gross_native_raw numeric(78,0) not null check (gross_native_raw >= 0),
  prize_native_raw numeric(78,0) not null check (prize_native_raw >= 0),
  marketing_native_raw numeric(78,0) not null check (marketing_native_raw >= 0),
  protocol_native_raw numeric(78,0) not null check (protocol_native_raw >= 0),
  tx_hash text,
  signature_reference text,
  block_number bigint,
  status text not null default 'pending'
    check (status in ('pending','submitted','confirming','recovering','verifying','confirmed','failed','expired')),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sponsorship_payments_confirmation_check check (
    status <> 'confirmed' or confirmed_at is not null
  )
);

create index if not exists sponsorship_payments_quote_idx
  on public.sponsorship_payments(quote_id, created_at desc);
create index if not exists sponsorship_payments_event_sponsorship_idx
  on public.sponsorship_payments(event_sponsorship_id, created_at desc);

comment on table public.sponsor_profiles is
  'Sponsor identity/profile used by Warzone Event Sponsorship. Separate from advertising sponsorship_applications.';
comment on table public.sponsorship_events is
  'Canonical registry binding Warzone Event Sponsorship to a chain and canonical arena event reference.';
comment on table public.sponsorship_payment_quotes is
  'Immutable-value sponsorship payment quote identity; lifecycle/recovery columns may advance state only.';
comment on table public.sponsorship_payments is
  'Authoritative event sponsorship payment evidence in raw native units.';
comment on table public.event_sponsorships is
  'Warzone Event Sponsorship record activated only after authoritative payment confirmation.';

commit;
