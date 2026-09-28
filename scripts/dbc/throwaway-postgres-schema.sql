-- Minimum schema for DBC step-5 proof and integration tests. No lowercase CHECKs
-- (Solana base58 is mixed-case). Applied to a throwaway initdb on port 55432.
create extension if not exists pgcrypto;

create table if not exists public.campaigns (
  chain_id integer not null,
  campaign_address text not null,
  token_address text,
  creator_address text,
  name text,
  symbol text,
  logo_uri text,
  factory_address text,
  launch_type text not null default 'launchpad',
  created_block bigint not null default 0,
  is_active boolean not null default true,
  launched boolean not null default false,
  created_at_chain timestamptz,
  graduated_at_chain timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb,
  primary key (chain_id, campaign_address)
);

create table if not exists public.indexer_state (
  chain_id integer not null,
  cursor text not null,
  last_indexed_block bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (chain_id, cursor)
);

create table if not exists public.curve_trades (
  chain_id integer not null,
  campaign_address text not null,
  tx_hash text not null,
  log_index integer not null,
  block_number bigint not null,
  block_time timestamptz not null,
  side text not null,
  wallet text not null,
  token_amount_raw numeric not null,
  bnb_amount_raw numeric not null,
  token_amount double precision,
  bnb_amount double precision,
  price_bnb double precision,
  venue text,
  created_at timestamptz not null default now(),
  primary key (chain_id, tx_hash, log_index)
);

create table if not exists public.activity_events (
  id bigserial primary key,
  chain_id integer not null,
  event_type text not null,
  tx_hash text not null,
  log_index integer not null,
  block_number bigint not null,
  block_time timestamptz not null,
  actor_address text not null,
  campaign_address text,
  token_address text,
  amount_in_wei numeric,
  amount_out_wei numeric,
  cost_wei numeric,
  payout_wei numeric,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index)
);

create table if not exists public.token_candles (
  chain_id integer not null,
  campaign_address text not null,
  timeframe text not null,
  bucket_start timestamptz not null,
  o numeric not null,
  h numeric not null,
  l numeric not null,
  c numeric not null,
  volume_bnb numeric not null default 0,
  trades_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (chain_id, campaign_address, timeframe, bucket_start)
);

create table if not exists public.token_stats (
  chain_id integer not null,
  campaign_address text not null,
  last_price_bnb numeric,
  vol24h_bnb numeric,
  updated_at timestamptz not null default now(),
  primary key (chain_id, campaign_address)
);

create table if not exists public.recruiters (
  id bigint generated always as identity primary key,
  wallet_address text not null,
  code text not null,
  display_name text,
  is_og boolean not null default false,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (wallet_address),
  unique (code)
);

create table if not exists public.wallet_recruiter_links (
  id bigint generated always as identity primary key,
  wallet_address text not null,
  recruiter_id bigint not null references public.recruiters(id),
  link_source text not null default 'manual',
  linked_at timestamptz not null default now(),
  detached_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.epochs (
  id bigint generated always as identity primary key,
  chain_id integer not null,
  epoch_type text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  unique (chain_id, epoch_type, start_at)
);

create table if not exists public.reward_events (
  id bigint generated always as identity primary key,
  chain_id integer not null,
  tx_hash text not null,
  log_index integer not null,
  block_number bigint not null,
  occurred_at timestamptz not null,
  epoch_id bigint not null references public.epochs(id),
  wallet_address text,
  campaign_address text,
  route_kind text not null,
  route_profile text not null,
  league_amount numeric not null default 0,
  recruiter_amount numeric not null default 0,
  airdrop_amount numeric not null default 0,
  squad_amount numeric not null default 0,
  protocol_amount numeric not null default 0,
  raw_amount numeric not null,
  source_contract text not null,
  source_event text not null default 'RouteExecuted',
  matched_activity_source text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index)
);

create table if not exists public.campaign_drafts (
  id uuid primary key default gen_random_uuid(),
  creator_wallet text,
  launch_type text,
  dbc_fee_choice text,
  scheduled_launch_at timestamptz
);

create table if not exists public.ticker_reservations (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid,
  creator_wallet text not null,
  chain_id integer not null,
  cluster text not null,
  original_ticker text not null,
  normalized_ticker text not null,
  ticker_hash text not null,
  reservation_id_hash text not null,
  status text not null,
  reserved_at timestamptz not null default now(),
  published_at timestamptz,
  expires_at timestamptz,
  grace_end_at timestamptz,
  renewal_count smallint not null default 0,
  scheduled_launch_at timestamptz,
  arm_authorized_at timestamptz,
  arming_at timestamptz,
  armed_at timestamptz,
  live_at timestamptz,
  schedule_missed_at timestamptz,
  released_at timestamptz,
  program_id text,
  generation_id text,
  campaign_pda text,
  mint text,
  deployment_signature text,
  reservation_version bigint not null default 1,
  authorization_nonce text,
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ticker_reservation_events (
  id bigint generated by default as identity primary key,
  reservation_id uuid not null references public.ticker_reservations(id) on delete cascade,
  event_type text not null,
  from_status text,
  to_status text,
  actor_type text not null default 'system',
  actor_wallet text,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.token_metadata_registry (
  id bigserial primary key,
  chain_id integer,
  campaign_address text,
  token_address text,
  creator_address text,
  name text,
  symbol text,
  description text,
  logo_uri text,
  metadata_uri text,
  website text,
  x_account text,
  telegram text,
  discord text,
  source text,
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.dbc_launch_configs (
  id bigserial primary key,
  cluster text not null,
  quote_mint text not null,
  target_usd_micros bigint not null,
  step_index integer not null,
  step_usd_micros bigint not null,
  creator_fee_mode text not null,
  params_hash text not null,
  config_address text,
  threshold_lamports bigint not null,
  total_token_supply bigint not null,
  create_signature text,
  status text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (cluster, quote_mint, target_usd_micros, step_index, creator_fee_mode, params_hash)
);
