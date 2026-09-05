-- Warzone Event Sponsorship authority. Additive only.
-- IMPORTANT: public.sponsorship_applications is the separate advertising product and is intentionally untouched.

create table if not exists public.event_sponsorship_applications (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.sponsorship_events(id) on delete restrict,
  chain_id integer not null,
  sponsor_profile_id uuid not null references public.sponsor_profiles(id) on delete restrict,
  sponsor_wallet text not null,
  status text not null default 'submitted' check (status in ('submitted','under_review','approved','rejected','cancelled')),
  brand_name text,
  contact_name text,
  contact_email text,
  creative_url text,
  cta_url text,
  review_reason text,
  reviewed_by text,
  reviewed_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists event_sponsorship_applications_event_idx
  on public.event_sponsorship_applications(event_id, created_at desc);
create index if not exists event_sponsorship_applications_wallet_idx
  on public.event_sponsorship_applications(chain_id, sponsor_wallet, created_at desc);
create unique index if not exists event_sponsorship_application_live_uidx
  on public.event_sponsorship_applications(event_id, chain_id, sponsor_wallet)
  where status in ('submitted','under_review','approved');

alter table if exists public.sponsorship_payment_quotes
  add column if not exists event_sponsorship_application_id uuid references public.event_sponsorship_applications(id) on delete restrict;

-- One authoritative confirmed payment per immutable quote. This makes prize credit single-shot.
create unique index if not exists sponsorship_payments_one_confirmed_quote_uidx
  on public.sponsorship_payments(quote_id)
  where status = 'confirmed';

-- Conservation and exact founder-locked 70/20/10 split. Remainder belongs to prize.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sponsorship_payments_conserves_native') then
    alter table public.sponsorship_payments add constraint sponsorship_payments_conserves_native
      check (
        gross_native_raw >= 0
        and prize_native_raw >= 0
        and marketing_native_raw >= 0
        and protocol_native_raw >= 0
        and prize_native_raw + marketing_native_raw + protocol_native_raw = gross_native_raw
      ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sponsorship_payments_exact_70_20_10') then
    alter table public.sponsorship_payments add constraint sponsorship_payments_exact_70_20_10
      check (
        marketing_native_raw = (gross_native_raw * 2000) / 10000
        and protocol_native_raw = (gross_native_raw * 1000) / 10000
        and prize_native_raw = gross_native_raw - ((gross_native_raw * 2000) / 10000) - ((gross_native_raw * 1000) / 10000)
      ) not valid;
  end if;
end $$;

create table if not exists public.event_sponsorship_audit_log (
  id bigserial primary key,
  event_id uuid references public.sponsorship_events(id) on delete restrict,
  application_id uuid references public.event_sponsorship_applications(id) on delete set null,
  quote_id uuid references public.sponsorship_payment_quotes(id) on delete set null,
  payment_id uuid references public.sponsorship_payments(id) on delete set null,
  event_type text,
  chain_id integer,
  sponsor_wallet text,
  action text not null,
  state_from text,
  state_to text,
  payment_identity text,
  evidence jsonb not null default '{}'::jsonb,
  actor text,
  created_at timestamptz not null default now()
);
create index if not exists event_sponsorship_audit_event_idx
  on public.event_sponsorship_audit_log(event_id, created_at desc);
create index if not exists event_sponsorship_audit_application_idx
  on public.event_sponsorship_audit_log(application_id, created_at desc);

-- Append-only history of the deterministic first authoritative confirmed sponsor per event.
create table if not exists public.event_sponsorship_founding_history (
  id bigserial primary key,
  event_id uuid not null references public.sponsorship_events(id) on delete restrict,
  event_sponsorship_id uuid not null references public.event_sponsorships(id) on delete restrict,
  payment_id uuid not null references public.sponsorship_payments(id) on delete restrict,
  sponsor_profile_id uuid not null references public.sponsor_profiles(id) on delete restrict,
  sponsor_wallet text not null,
  confirmed_at timestamptz not null,
  payment_identity text not null,
  supersedes_history_id bigint references public.event_sponsorship_founding_history(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(event_id, payment_id)
);
create index if not exists event_sponsorship_founding_event_idx
  on public.event_sponsorship_founding_history(event_id, created_at desc);

-- Explicit cancellation policy state. No automatic refund or treasury transfer is created here.
alter table if exists public.event_sponsorships
  add column if not exists cancellation_state text,
  add column if not exists cancellation_reason text,
  add column if not exists cancelled_at timestamptz;

alter table if exists public.sponsorship_payment_quotes
  add column if not exists generic_payment_state text;

comment on table public.event_sponsorship_applications is
  'Warzone Event Sponsorship applications. Separate from advertising sponsorship_applications.';
comment on table public.event_sponsorship_founding_history is
  'Append-only authoritative confirmed-payment ordering history for Founding Sponsor identity.';
