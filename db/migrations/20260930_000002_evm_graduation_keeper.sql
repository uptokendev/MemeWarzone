-- EVM graduation keeper (launch generation, campaign 5). Every transaction is written here, signed,
-- BEFORE it is broadcast: status 'sending' holds the hash, the nonce and the raw signed transaction, so a
-- restart resolves it by receipt, re-broadcasts the same bytes while the nonce is unused, or marks it
-- 'dropped' when the nonce went to another transaction. At most one 'sending' row per chain at a time
-- (enforced by the keeper; the partial unique index below makes it a database fact too).
begin;

create table if not exists public.evm_graduation_keeper_jobs (
  id bigserial primary key,
  chain_id integer not null,
  campaign_address text not null,
  action text not null,
  call_args jsonb not null default '[]'::jsonb,
  keeper_address text not null,
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
  constraint evm_graduation_keeper_jobs_action_check
    check (action in ('graduate', 'repair', 'native_fallback', 'flush')),
  constraint evm_graduation_keeper_jobs_status_check
    check (status in ('sending', 'confirmed', 'reverted', 'dropped'))
);

create unique index if not exists evm_graduation_keeper_jobs_tx_idx
  on public.evm_graduation_keeper_jobs (chain_id, tx_hash);
create unique index if not exists evm_graduation_keeper_jobs_one_in_flight_idx
  on public.evm_graduation_keeper_jobs (chain_id)
  where status = 'sending';
create index if not exists evm_graduation_keeper_jobs_campaign_idx
  on public.evm_graduation_keeper_jobs (chain_id, campaign_address, created_at desc);

-- Why a pending campaign could not be advanced on the last pass (named revert or gas), for ops.
create table if not exists public.evm_graduation_keeper_blocks (
  chain_id integer not null,
  campaign_address text not null,
  reason text not null,
  seen_at timestamptz not null default now(),
  primary key (chain_id, campaign_address)
);

comment on table public.evm_graduation_keeper_jobs is
  'EVM graduation keeper sends (graduate / repairPool / useNativeFallback / flushProtocolGraduationFee), recorded before broadcast.';

commit;
