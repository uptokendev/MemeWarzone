-- DBC graduation keeper (2026-09-29). Jobs track locker/migrate/mark/withdraw/compensate/route.
-- LP claims are a separate hourly schedule (lp_signature holds a pending LP send).
-- Compensations record D7 (Meteora 0.2% cut paid from the protocol slice).
begin;

alter table public.campaigns add column if not exists graduated_block bigint;

create table if not exists public.dbc_graduation_jobs (
  id bigserial primary key,
  pool text not null unique,
  campaign text,
  mint text,
  config text,
  creator text,
  step text not null default 'locker',
  status text not null default 'ready',
  signature text,
  last_valid_block_height bigint,
  attempt integer not null default 0,
  backoff_until timestamptz,
  blocked_reason text,
  damm_pool text,
  locker text,
  partner_fee numeric,
  compensation numeric,
  shortfall numeric,
  first_position_nft text,
  second_position_nft text,
  lp_claimed numeric,
  lp_signature text,
  lp_last_valid_block_height bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dbc_graduation_jobs_status_check check (status in ('ready', 'sending', 'done', 'blocked')),
  constraint dbc_graduation_jobs_step_check check (step in ('locker', 'migrate', 'mark', 'withdraw', 'compensate', 'route', 'done'))
);

create index if not exists dbc_graduation_jobs_status_idx
  on public.dbc_graduation_jobs (status, step)
  where status in ('ready', 'sending');

create table if not exists public.dbc_graduation_compensations (
  id bigserial primary key,
  pool text not null unique,
  creator text not null,
  lamports numeric not null,
  quote_cut numeric not null,
  base_cut numeric not null,
  base_as_sol numeric not null,
  total_due numeric not null,
  shortfall numeric not null default 0,
  remaining_for_route numeric not null default 0,
  tx text,
  created_at timestamptz not null default now()
);

comment on table public.dbc_graduation_jobs is
  'DBC curve graduation keeper. status=sending holds a signed tx until getSignatureStatuses + getBlockHeight resolve it. LP claims use lp_signature after the job is done.';
comment on table public.dbc_graduation_compensations is
  'D7: Meteora 0.2% migration liquidity cut paid to the creator from the protocol slice of the kind-1 partner fee.';

commit;
