-- DBC collector fee accruals (2026-09-28) and Solana-safe reward_events addresses.
-- The original reward_events CHECKs required lowercase; Solana base58 is mixed-case.
begin;

alter table public.reward_events drop constraint if exists reward_events_txhash_lowercase;
alter table public.reward_events drop constraint if exists reward_events_wallet_lowercase;
alter table public.reward_events drop constraint if exists reward_events_campaign_lowercase;
alter table public.reward_events drop constraint if exists reward_events_source_contract_lowercase;

create table if not exists public.dbc_fee_accruals (
  id bigserial primary key,
  pool text not null,
  tx_hash text not null,
  log_index integer not null,
  trader text not null,
  profile text not null,
  fee_total numeric not null,
  trading_fee numeric not null,
  protocol_fee numeric not null,
  referral_fee numeric not null,
  collector_amount numeric not null,
  league_weekly numeric not null,
  league_monthly numeric not null,
  recruiter numeric not null,
  squad numeric not null,
  airdrop numeric not null,
  protocol numeric not null,
  creator_pool numeric not null default 0,
  status text not null,
  claim_signature text,
  route_signature text,
  blocked_reason text,
  created_at timestamptz not null default now(),
  unique (tx_hash, log_index),
  constraint dbc_fee_accruals_status_chk check (status in ('accrued', 'claimed', 'routed', 'blocked')),
  constraint dbc_fee_accruals_profile_chk check (profile in ('standard_linked', 'standard_unlinked', 'og_linked')),
  constraint dbc_fee_accruals_nonneg_chk check (
    fee_total >= 0 and trading_fee >= 0 and protocol_fee >= 0 and referral_fee >= 0
    and collector_amount >= 0 and league_weekly >= 0 and league_monthly >= 0
    and recruiter >= 0 and squad >= 0 and airdrop >= 0 and protocol >= 0 and creator_pool >= 0
  )
);

create index if not exists dbc_fee_accruals_pool_status_idx on public.dbc_fee_accruals (pool, status);

commit;
