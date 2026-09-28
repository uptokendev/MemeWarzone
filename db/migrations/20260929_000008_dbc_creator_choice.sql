-- DBC step 5b (2026-09-29): paying out the creator-fee choice of platform coins (holders / split / buyback).
-- Unpaid per coin = creator_pool on the collector (dbc_fee_accruals, claimed/routing/routed) minus the
-- payouts below that are sending or landed. A holder share below the minimum is simply not paid out,
-- so it stays unpaid and rolls into the next week without a separate carry table.
begin;

-- One week's secret: its sha256 is published before the week starts, the secret after it ends.
create table if not exists public.dbc_buyback_weeks (
  week_id text primary key,
  commitment text not null,
  secret text,
  revealed_at timestamptz,
  created_at timestamptz not null default now()
);

-- Holder balances of a platform coin's mint at the week's snapshot moment. Wallets only.
create table if not exists public.dbc_holder_snapshots (
  week_id text not null,
  mint text not null,
  owner text not null,
  amount numeric not null,
  primary key (week_id, mint, owner)
);

create table if not exists public.dbc_holder_snapshot_runs (
  week_id text not null,
  mint text not null,
  pool text not null,
  taken_at timestamptz not null default now(),
  slot bigint,
  holders integer not null,
  primary key (week_id, mint)
);

-- The week's holder deposit into airdrop_vault. The airdrop runner adds these leaves (program code 2)
-- to its weekly batch and sets airdrop_epoch_id when it materializes them.
create table if not exists public.dbc_holder_rounds (
  week_id text primary key,
  total_lamports numeric not null,
  leaves jsonb not null,
  status text not null,
  signature text,
  last_valid_block_height bigint,
  airdrop_epoch_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dbc_holder_rounds_status_chk check (status in ('ready', 'sending', 'landed', 'failed'))
);

create table if not exists public.dbc_creator_pool_payouts (
  id bigserial primary key,
  pool text not null,
  kind text not null,
  week_id text not null,
  moment_key text not null,
  lamports numeric not null,
  tokens_burned numeric,
  recipient text,
  signature text,
  last_valid_block_height bigint,
  status text not null,
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dbc_creator_pool_payouts_kind_chk check (kind in ('holders', 'creator', 'buyback')),
  constraint dbc_creator_pool_payouts_status_chk check (status in ('sending', 'landed', 'failed')),
  constraint dbc_creator_pool_payouts_nonneg_chk check (lamports >= 0 and coalesce(tokens_burned, 0) >= 0)
);

create index if not exists dbc_creator_pool_payouts_pool_idx on public.dbc_creator_pool_payouts (pool, status);
-- One live payout per coin, kind and moment. A failed one never moved money and may be retried.
create unique index if not exists dbc_creator_pool_payouts_moment_uq
  on public.dbc_creator_pool_payouts (pool, kind, moment_key) where status <> 'failed';

commit;
