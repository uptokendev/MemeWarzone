-- EVM creator-choice operator (launch generation, BNB 56 + Robinhood 4663): the worker that moves the
-- CreatorRewardsVaultV2 money of holders / split / buyback coins (realtime-indexer/src/evm/evmCreatorChoicePass.ts).
-- Every transaction is written here, signed, BEFORE it is broadcast (status 'sending' holds the hash, the nonce
-- and the raw signed transaction), so a restart resolves it by receipt, re-broadcasts the same bytes while the
-- nonce is unused, or marks it 'dropped'. A live (sending / confirmed) job per subject, action and moment is
-- unique, so nothing is sent twice. Not applied by the worker: run by hand on staging, then production.
begin;

-- One secret per chain and week: sha256 published before the week starts, the secret after it ends.
create table if not exists public.evm_creator_choice_weeks (
  chain_id integer not null,
  week_id text not null,
  commitment text not null,
  secret text,
  revealed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (chain_id, week_id)
);

-- Holder balances of a holders / split coin at the week's snapshot moment. Wallets only (no contracts,
-- no creator, vault, pool, operator, excluded or risk-restricted wallets). Lowercase addresses.
create table if not exists public.evm_holder_snapshots (
  chain_id integer not null,
  week_id text not null,
  campaign_address text not null,
  wallet text not null,
  amount numeric(78,0) not null,
  primary key (chain_id, week_id, campaign_address, wallet),
  constraint evm_holder_snapshots_amount_chk check (amount > 0)
);

create table if not exists public.evm_holder_snapshot_runs (
  chain_id integer not null,
  week_id text not null,
  campaign_address text not null,
  token_address text not null,
  block_number bigint not null,
  holders integer not null,
  taken_at timestamptz not null default now(),
  primary key (chain_id, week_id, campaign_address)
);

-- One holder batch per chain and week. leaf_file is the published leaf file (the Safe signers recompute the
-- root from it with scripts/evm-holder-batch-verify.mjs). status: built -> proposing -> proposed ->
-- executing -> executed, or vetoed / failed / empty.
create table if not exists public.evm_holder_batches (
  chain_id integer not null,
  week_id text not null,
  vault_address text not null,
  batch_id text not null,
  root text,
  total_raw numeric(78,0),
  claim_deadline bigint,
  leaf_file jsonb,
  status text not null,
  attempt integer not null default 0,
  reward_batch_id uuid,
  executable_at timestamptz,
  last_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chain_id, week_id),
  constraint evm_holder_batches_status_chk
    check (status in ('built', 'proposing', 'proposed', 'executing', 'executed', 'vetoed', 'failed', 'empty'))
);
create index if not exists evm_holder_batches_open_idx
  on public.evm_holder_batches (chain_id, status)
  where status not in ('executed', 'vetoed', 'empty');
create unique index if not exists evm_holder_batches_batch_idx on public.evm_holder_batches (chain_id, batch_id);

create table if not exists public.evm_creator_choice_jobs (
  id bigserial primary key,
  chain_id integer not null,
  vault_address text not null,
  subject text not null,
  action text not null,
  moment_key text not null,
  interval_key text,
  call_args jsonb not null default '[]'::jsonb,
  amount_raw numeric(78,0),
  operator_address text not null,
  nonce bigint not null,
  gas_limit numeric(78,0),
  tx_hash text not null,
  raw_tx text not null,
  status text not null default 'sending',
  reason text,
  attempt integer not null default 0,
  last_error text,
  receipt_block bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint evm_creator_choice_jobs_action_chk
    check (action in ('sync_lp', 'buyback_curve', 'buyback_pool', 'flush', 'convert_holder_quote',
                      'convert_buyback_quote', 'propose_holder_batch', 'execute_holder_batch')),
  constraint evm_creator_choice_jobs_status_chk
    check (status in ('sending', 'confirmed', 'reverted', 'dropped'))
);
create unique index if not exists evm_creator_choice_jobs_tx_idx on public.evm_creator_choice_jobs (chain_id, tx_hash);
-- At most one transaction in flight per chain.
create unique index if not exists evm_creator_choice_jobs_one_in_flight_idx
  on public.evm_creator_choice_jobs (chain_id) where status = 'sending';
-- Never twice: one live job per subject, action and moment.
create unique index if not exists evm_creator_choice_jobs_live_idx
  on public.evm_creator_choice_jobs (chain_id, subject, action, moment_key) where status in ('sending', 'confirmed');
create index if not exists evm_creator_choice_jobs_subject_idx
  on public.evm_creator_choice_jobs (chain_id, subject, action, created_at desc);

comment on table public.evm_creator_choice_jobs is
  'CreatorRewardsVaultV2 operator sends (syncLpFees, buybacks, flush, conversions, holder batches), recorded before broadcast.';

commit;
