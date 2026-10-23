-- Gen-8 creator-choice operator (BNB 56, Robinhood 4663): MwzCreatorChoiceVault pulls, hold-through holder checks,
-- weekly holder batches and buybacks (realtime-indexer/src/evm/evmGen8ChoicePass.ts). Additive only: no existing
-- table, column, constraint or row changes. The weekly batch itself is stored in public.evm_holder_batches (one row
-- per chain, vault and week, migration 20261008_000040) and published to the Claim Center tables like gen-6 / gen-7.
--
--   evm_gen8_holder_check_runs  one row per chain, week, coin and check (0..3): the census block the check was read at,
--                               its block time, the token's totalSupply at that block and the holder count. Written in
--                               the SAME statement as its wallets (one CTE), so a check is either whole or absent.
--   evm_gen8_holder_checks      the wallets of one check after the hard skip, the contract filter and the soft
--                               exclusions (evmGen8HoldThrough.ts gen8EligibleAt), lowercase, amount > 0.
--   evm_gen8_choice_jobs        every operator transaction, written signed (nonce, hash, raw bytes) BEFORE it is
--                               broadcast, so a restart resolves it by receipt, re-broadcasts the same bytes while the
--                               nonce is unused, or marks it dropped once the nonce went elsewhere. At most one job in
--                               flight per chain; one live job per vault, subject, action and moment.
-- Not applied by the worker: run by hand on staging, then production (founder).
begin;

create table if not exists public.evm_gen8_holder_check_runs (
  chain_id integer not null,
  week_id text not null,
  pool_id text not null,
  check_index smallint not null,
  token_address text not null,
  moment_at timestamptz not null,
  block_number bigint not null,
  block_time bigint not null,
  supply numeric(78,0) not null,
  holders integer not null,
  soft_excluded numeric(78,0) not null default 0,
  eligible_supply numeric(78,0) not null default 0,
  -- The wallets the configured / risk lists removed at this check, as the lists were then (lowercase, sorted); the
  -- v2 leaf file's checks[].softExcluded.
  soft_excluded_wallets text[] not null default '{}',
  rule text not null default 'hold-through-v1',
  taken_at timestamptz not null default now(),
  primary key (chain_id, week_id, pool_id, check_index),
  constraint evm_gen8_holder_check_runs_index_chk check (check_index between 0 and 3),
  constraint evm_gen8_holder_check_runs_supply_chk check (supply > 0),
  constraint evm_gen8_holder_check_runs_holders_chk check (holders >= 0)
);

create table if not exists public.evm_gen8_holder_checks (
  chain_id integer not null,
  week_id text not null,
  pool_id text not null,
  check_index smallint not null,
  wallet text not null,
  amount numeric(78,0) not null,
  primary key (chain_id, week_id, pool_id, check_index, wallet),
  constraint evm_gen8_holder_checks_amount_chk check (amount > 0),
  constraint evm_gen8_holder_checks_run_fk foreign key (chain_id, week_id, pool_id, check_index)
    references public.evm_gen8_holder_check_runs (chain_id, week_id, pool_id, check_index) on delete cascade
);

create table if not exists public.evm_gen8_choice_jobs (
  id bigserial primary key,
  chain_id integer not null,
  vault_address text not null,
  operator_address text not null,
  subject text not null,
  action text not null,
  moment_key text not null,
  call_args jsonb not null default '[]'::jsonb,
  amount_raw numeric(78,0),
  nonce bigint not null,
  gas_limit numeric(78,0) not null,
  tx_hash text not null,
  raw_tx text not null,
  status text not null default 'sending',
  reason text,
  attempt integer not null default 0,
  last_error text,
  receipt_block bigint,
  -- Latest block timestamp when the job was signed: the vault's caps and intervals run on chain time.
  chain_time bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint evm_gen8_choice_jobs_action_chk check (action in ('pull', 'buyback', 'propose_holder_batch', 'execute_holder_batch')),
  constraint evm_gen8_choice_jobs_status_chk check (status in ('sending', 'confirmed', 'reverted', 'dropped'))
);
create unique index if not exists evm_gen8_choice_jobs_tx_idx on public.evm_gen8_choice_jobs (chain_id, tx_hash);
-- At most one transaction in flight per chain.
create unique index if not exists evm_gen8_choice_jobs_one_in_flight_idx
  on public.evm_gen8_choice_jobs (chain_id) where status = 'sending';
-- Never twice: one live job per vault, subject, action and moment.
create unique index if not exists evm_gen8_choice_jobs_live_idx
  on public.evm_gen8_choice_jobs (chain_id, vault_address, subject, action, moment_key) where status in ('sending', 'confirmed');
create index if not exists evm_gen8_choice_jobs_subject_idx
  on public.evm_gen8_choice_jobs (chain_id, subject, action, created_at desc);

-- Where an earlier draft of this table exists without the column.
alter table public.evm_gen8_holder_check_runs add column if not exists soft_excluded_wallets text[] not null default '{}';

comment on table public.evm_gen8_choice_jobs is
  'MwzCreatorChoiceVault operator sends (pull, buyback, proposeHolderBatch, executeHolderBatch), recorded signed before broadcast.';
comment on table public.evm_gen8_holder_check_runs is
  'Gen-8 hold-through holder checks (evmGen8HoldThrough.ts): one row per chain, week, coin and check.';

-- Indexer only. Without this, the public anon key could insert a wallet into a check before the indexer writes it, or
-- read which checks are done before the week secret is revealed.
alter table public.evm_gen8_holder_check_runs enable row level security;
alter table public.evm_gen8_holder_checks enable row level security;
alter table public.evm_gen8_choice_jobs enable row level security;
-- evm_holder_batches and evm_creator_choice_weeks (20260930_300001) were created without row level security: closed
-- here so the anon key never reads an unpublished leaf file or a week secret before its reveal. The API and the
-- indexer connect as the owner (pg), no supabase-js / anon reader exists, so they are unaffected.
do $$
begin
  if to_regclass('public.evm_holder_batches') is not null then
    execute 'alter table public.evm_holder_batches enable row level security';
    if exists (select 1 from pg_roles where rolname = 'anon') and exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'revoke all on public.evm_holder_batches from anon, authenticated';
    end if;
  end if;
  if to_regclass('public.evm_creator_choice_weeks') is not null then
    execute 'alter table public.evm_creator_choice_weeks enable row level security';
    if exists (select 1 from pg_roles where rolname = 'anon') and exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute 'revoke all on public.evm_creator_choice_weeks from anon, authenticated';
    end if;
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.evm_gen8_holder_check_runs, public.evm_gen8_holder_checks, public.evm_gen8_choice_jobs from anon, authenticated;
    revoke all on sequence public.evm_gen8_choice_jobs_id_seq from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.evm_gen8_holder_check_runs, public.evm_gen8_holder_checks, public.evm_gen8_choice_jobs to service_role;
    grant usage, select on sequence public.evm_gen8_choice_jobs_id_seq to service_role;
  end if;
end $$;

commit;
