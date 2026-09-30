-- MemeWarzone combined release (Solana DBC + EVM launch generation 6/5): production migrations, in order.
-- Generated 2026-10-01 from release/all-chains.
--
--   Part 1: the Solana DBC bundle (docs/dbc/release/dbc-solana-migrations.sql), 20260929_000001 .. 000011, verbatim.
--   Part 2: every EVM migration 20260930_* in filename order, verbatim.
--   NOT included: 20261001_000001_arena_vote_battle_48h.sql (already applied on production by the founder).
--
-- Each migration runs in its own transaction (every file carries its own begin/commit;
-- 20260930_000003 ships without one and is wrapped here). Everything is create-if-not-exists /
-- add-column-if-not-exists / drop-constraint-if-exists / create-or-replace, so the whole file is re-runnable.
-- Proven 2026-10-01: applied twice, ON_ERROR_STOP, to a local PostgreSQL loaded with the staging public schema
-- and again with the production public schema (both schema-only dumps).
--
-- Re-run: 20260930_200001 and 20260930_300002 both set evm_graduation_keeper_jobs_action_check to the
-- same full list (including 'harvest'), so the whole file stays re-runnable after the keeper has run.
--
-- Run the whole file once in the Supabase SQL editor (production).
-- ############################## Part 1: Solana DBC ##############################
-- ===== 20260929_000001_dbc_launch_configs.sql =====
-- DBC config ladder (2026-09-29). One immutable on-chain config per
-- (cluster, quote mint, dollar target, SOL-price step, creator-fee mode, params hash).
-- Rows without an on-chain address stay pending until creation + readback succeed.
begin;

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
  constraint dbc_launch_configs_cluster_check check (cluster in ('devnet', 'mainnet-beta')),
  constraint dbc_launch_configs_fee_mode_check check (creator_fee_mode in ('creator', 'platform')),
  constraint dbc_launch_configs_status_check check (status in ('pending', 'active', 'failed')),
  constraint dbc_launch_configs_params_hash_check check (params_hash ~ '^[0-9a-f]{64}$'),
  constraint dbc_launch_configs_target_check check (target_usd_micros > 0),
  constraint dbc_launch_configs_step_check check (step_usd_micros > 0)
);

create unique index if not exists dbc_launch_configs_key_uidx
  on public.dbc_launch_configs (cluster, quote_mint, target_usd_micros, step_index, creator_fee_mode, params_hash);

create index if not exists dbc_launch_configs_active_idx
  on public.dbc_launch_configs (cluster, target_usd_micros, step_index, creator_fee_mode)
  where status = 'active';

comment on table public.dbc_launch_configs is
  'Pre-made Meteora DBC configs for the Solana launch ladder. Served only after on-chain readback matches the expected params.';

alter table public.dbc_launch_configs enable row level security;
revoke all on public.dbc_launch_configs from anon, authenticated;
grant select, insert, update, delete on public.dbc_launch_configs to service_role;
grant usage, select on sequence public.dbc_launch_configs_id_seq to service_role;

commit;

-- ===== 20260929_000002_campaigns_launch_type.sql =====
-- DBC launch type on campaigns (2026-09-29). Existing rows stay launchpad.
-- DBC coins use campaign_address = pool and token_address = mint.
begin;

alter table public.campaigns
  add column if not exists launch_type text not null default 'launchpad';

alter table public.campaigns drop constraint if exists campaigns_launch_type_check;
alter table public.campaigns add constraint campaigns_launch_type_check
  check (launch_type in ('launchpad', 'dbc'));

create index if not exists campaigns_chain_launch_type_idx
  on public.campaigns (chain_id, launch_type);

comment on column public.campaigns.launch_type is
  'launchpad = existing Solana/EVM bonding campaign; dbc = Meteora DBC pool (campaign_address is the pool).';

commit;

-- ===== 20260929_000003_campaign_drafts_dbc.sql =====
-- DBC draft fields and scheduled launches (D18, 2026-09-29).
-- A DBC pool trades the moment it is created, so a scheduled DBC launch is a
-- draft with a launch time. Nothing is created on chain until the creator deploys.
begin;

alter table public.campaign_drafts
  add column if not exists launch_type text not null default 'launchpad';
alter table public.campaign_drafts drop constraint if exists campaign_drafts_launch_type_check;
alter table public.campaign_drafts add constraint campaign_drafts_launch_type_check
  check (launch_type in ('launchpad', 'dbc'));

alter table public.campaign_drafts
  add column if not exists dbc_fee_choice text;
alter table public.campaign_drafts drop constraint if exists campaign_drafts_dbc_fee_choice_check;
alter table public.campaign_drafts add constraint campaign_drafts_dbc_fee_choice_check
  check (dbc_fee_choice is null or dbc_fee_choice in ('keep', 'holders', 'split', 'buyback'));

alter table public.campaign_drafts
  add column if not exists dbc_creator_share_pct integer;
alter table public.campaign_drafts
  add column if not exists dbc_first_buy_lamports numeric;

create index if not exists campaign_drafts_dbc_due_idx
  on public.campaign_drafts (creator_wallet, scheduled_launch_at)
  where launch_type = 'dbc' and status = 'scheduled' and campaign_address is null;

-- token_metadata_registry was EVM-only (0x). DBC writes Solana pool/mint/creator.
do $$
declare
  r record;
begin
  for r in
    select c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'token_metadata_registry'
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%0x[0-9a-f]{40}%'
  loop
    execute format('alter table public.token_metadata_registry drop constraint if exists %I', r.conname);
  end loop;
end $$;

alter table public.token_metadata_registry
  add constraint token_metadata_registry_campaign_address_check
  check (
    campaign_address is null
    or campaign_address ~* '^0x[0-9a-f]{40}$'
    or campaign_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  );
alter table public.token_metadata_registry
  add constraint token_metadata_registry_token_address_check
  check (
    token_address is null
    or token_address ~* '^0x[0-9a-f]{40}$'
    or token_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  );
alter table public.token_metadata_registry
  add constraint token_metadata_registry_creator_address_check
  check (
    creator_address is null
    or creator_address ~* '^0x[0-9a-f]{40}$'
    or creator_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  );

comment on column public.campaign_drafts.launch_type is
  'launchpad = existing create path; dbc = Meteora DBC (deploy happens when the timer ends).';

commit;

-- ===== 20260929_000004_dbc_creator_locks.sql =====
-- D12 extra creator buys through our site, recorded after on-chain verification.
begin;

create table if not exists public.dbc_creator_locks (
  id bigserial primary key,
  pool text not null,
  mint text not null,
  creator text not null,
  escrow text not null,
  amount numeric not null,
  cliff bigint not null,
  frequency bigint not null,
  periods integer not null,
  tx text,
  created_at timestamptz not null default now(),
  unique (escrow)
);

create index if not exists dbc_creator_locks_mint_idx on public.dbc_creator_locks (mint);
create index if not exists dbc_creator_locks_pool_idx on public.dbc_creator_locks (pool);

commit;

-- ===== 20260929_000005_curve_trades_venue.sql =====
-- DBC bonding trades share curve_trades with the launchpad. venue tells them apart
-- without the log_index < 20000 convention (20000+ stays reserved for post-grad).
begin;

alter table public.curve_trades add column if not exists venue text;

commit;

-- ===== 20260929_000006_dbc_fee_accruals.sql =====
-- DBC collector fee accruals (2026-09-28) and Solana-safe reward_events addresses.
-- The original reward_events CHECKs required lowercase; Solana base58 is mixed-case.
-- claiming/routing + last_valid_block_height: sign, persist, then send (review 1).
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
  last_valid_block_height bigint,
  blocked_reason text,
  created_at timestamptz not null default now(),
  unique (tx_hash, log_index),
  constraint dbc_fee_accruals_status_chk check (status in (
    'accrued', 'claiming', 'claimed', 'routing', 'routed', 'blocked'
  )),
  constraint dbc_fee_accruals_profile_chk check (profile in ('standard_linked', 'standard_unlinked', 'og_linked')),
  constraint dbc_fee_accruals_nonneg_chk check (
    fee_total >= 0 and trading_fee >= 0 and protocol_fee >= 0 and referral_fee >= 0
    and collector_amount >= 0 and league_weekly >= 0 and league_monthly >= 0
    and recruiter >= 0 and squad >= 0 and airdrop >= 0 and protocol >= 0 and creator_pool >= 0
  )
);

create index if not exists dbc_fee_accruals_pool_status_idx on public.dbc_fee_accruals (pool, status);

commit;

-- ===== 20260929_000007_dbc_graduation.sql =====
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

-- ===== 20260929_000008_dbc_creator_choice.sql =====
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

-- ===== 20260929_000009_dbc_quote_binding.sql =====
-- DBC 7a: bound-quote trades and Jupiter quote→SOL swaps.
begin;

alter table public.curve_trades
  add column if not exists quote_mint text,
  add column if not exists quote_amount_raw numeric;

alter table public.dbc_fee_accruals
  add column if not exists quote_swap_id bigint,
  add column if not exists sol_received numeric;

create table if not exists public.dbc_quote_swaps (
  id bigserial primary key,
  quote_mint text not null,
  quote_in numeric not null,
  sol_out numeric,
  impact_bps numeric,
  signature text,
  last_valid_block_height bigint,
  status text not null default 'ready',
  blocked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dbc_quote_swaps_status_check check (status in ('ready', 'sending', 'done', 'blocked'))
);

comment on table public.dbc_quote_swaps is
  'D21: collector swaps claimed quote tokens to SOL. status=sending holds a signed tx until getSignatureStatuses + getBlockHeight resolve it.';

commit;

-- ===== 20260929_000010_dbc_payout_quote.sql =====
-- DBC: creator-fee choices for coins paired with a quote other than SOL (USDC, USDT, xStocks).
-- A bound coin's pot is quote tokens on the collector, so its payout rows are in quote raw units:
--   creator  = quote tokens sent to the creator (split)
--   buyback  = quote tokens spent on the coin's own pool, bought tokens burned in the same tx
--   holders_swap = quote tokens swapped to SOL for the coin's holders (Jupiter); sol_received is the
--                  SOL that actually arrived and becomes that coin's part of the weekly holder round
--   holders  = SOL deposited into airdrop_vault for the round (every coin, always lamports)
-- `lamports` keeps its name: it is the raw amount in the coin's pot unit (quote_mint, null = SOL).
begin;

alter table public.dbc_creator_pool_payouts
  add column if not exists quote_mint text,
  add column if not exists quote_swap_id bigint,
  add column if not exists sol_received numeric;

alter table public.dbc_creator_pool_payouts drop constraint if exists dbc_creator_pool_payouts_kind_chk;
alter table public.dbc_creator_pool_payouts
  add constraint dbc_creator_pool_payouts_kind_chk check (kind in ('holders', 'creator', 'buyback', 'holders_swap'));

-- One quote->SOL swap per purpose (graduation route, LP claim, referral sweep, holder share). A
-- caller that finds its swap sending or done resumes it; before this, a retry after a pending send
-- started a second swap of the same amount, which could spend another coin's quote tokens.
alter table public.dbc_quote_swaps add column if not exists purpose_key text;
create unique index if not exists dbc_quote_swaps_purpose_uq on public.dbc_quote_swaps (purpose_key) where purpose_key is not null;

commit;

-- ===== 20260929_000011_campaign_drafts_dbc_quote.sql =====
-- DBC drafts keep the quote the creator chose (SOL when null). Without it a draft paired with USDC,
-- USDT or an xStock was deployed paired with SOL, directly or at its scheduled time.
begin;

alter table public.campaign_drafts
  add column if not exists dbc_quote_mint text;

-- The $150 DBC devnet tier (dbcGraduationTiers.ts) was allowed by the API but not by this check, so
-- no $150 DBC draft could be saved. Solana chains only, like the $6 tier; production refuses both in
-- the API (drafts.js).
alter table public.campaign_drafts drop constraint if exists campaign_drafts_graduation_target_check;
alter table public.campaign_drafts add constraint campaign_drafts_graduation_target_check check (
  graduation_target_wei in (
    6000000000000000000::numeric,
    150000000000000000000::numeric,
    15000000000000000000000::numeric,
    30000000000000000000000::numeric,
    50000000000000000000000::numeric
  )
  and (graduation_target_wei <> 6000000000000000000::numeric or chain_id in (97, 101, 102))
  and (graduation_target_wei <> 150000000000000000000::numeric or chain_id in (101, 102))
);

commit;

-- ############################## Part 2: EVM launch generation ##############################

-- ===== 20260930_000001_evm_gen5_indexing.sql =====
-- EVM launch generation (factory generation 6 / campaign generation 5) on BNB 56 and Robinhood 4663.
-- Indexer read model: which generation a campaign is, the fee actually charged on each trade (C2
-- anti-sniper fee), creator buys (C3 first buy, C4 escrow) and their exclusion from leagues (D13),
-- every generation-5 event, and the per-campaign graduation / escrow / fee-choice state.
-- The old generation keeps indexing exactly as before: every new column is nullable or defaults to the
-- old behaviour (league_excluded = false).
begin;

-- Selection per factory: the factory's CAMPAIGN_GENERATION(), written once by the indexer.
alter table public.campaigns add column if not exists factory_generation integer;
alter table public.campaigns add column if not exists campaign_generation integer;
create index if not exists campaigns_chain_campaign_generation_idx
  on public.campaigns (chain_id, campaign_generation)
  where campaign_generation is not null;
comment on column public.campaigns.campaign_generation is
  'EVM: the factory''s CAMPAIGN_GENERATION() (old mainnet factories 2/3, launch generation 5). Null = not resolved or not EVM.';

-- Gen-5 trades. bnb_amount_raw keeps its meaning (buy: cost incl. fee, sell: payout after fee).
alter table public.curve_trades add column if not exists fee_raw numeric(78,0);
alter table public.curve_trades add column if not exists fee_bps integer;
alter table public.curve_trades add column if not exists gross_raw numeric(78,0);
alter table public.curve_trades add column if not exists creator_buy_kind text;
alter table public.curve_trades add column if not exists league_excluded boolean not null default false;
alter table public.curve_trades drop constraint if exists curve_trades_creator_buy_kind_check;
alter table public.curve_trades add constraint curve_trades_creator_buy_kind_check
  check (creator_buy_kind is null or creator_buy_kind in ('first_buy', 'escrow'));
comment on column public.curve_trades.fee_raw is
  'Gen-5 EVM: native fee actually charged (anti-sniper 50% -> 2% over 60 s; first buy flat 2%). Null on older rows.';
comment on column public.curve_trades.fee_bps is 'Gen-5 EVM: fee rate applied to this trade, bps.';
comment on column public.curve_trades.gross_raw is 'Gen-5 EVM: buy = cost without fee; sell = gross before fee.';
comment on column public.curve_trades.creator_buy_kind is 'Gen-5 EVM: first_buy (C3, unlocked) or escrow (C4) when the buyer is the creator.';
comment on column public.curve_trades.league_excluded is 'D13: true for creator buys, which never count for leagues.';

-- Every gen-5 event (campaign, factory, router V4, creator vault V2, lockers), once.
create table if not exists public.evm_campaign_events (
  chain_id integer not null,
  contract_address text not null,
  contract_kind text not null,
  campaign_address text,
  event_name text not null,
  tx_hash text not null,
  log_index integer not null,
  block_number bigint not null,
  block_time timestamptz,
  args jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (chain_id, tx_hash, log_index),
  constraint evm_campaign_events_kind_check
    check (contract_kind in ('campaign', 'factory', 'router', 'creator_vault', 'lp_locker'))
);
create index if not exists evm_campaign_events_campaign_idx
  on public.evm_campaign_events (chain_id, campaign_address, event_name, block_number);
create index if not exists evm_campaign_events_contract_idx
  on public.evm_campaign_events (chain_id, contract_address, block_number);
comment on table public.evm_campaign_events is
  'EVM launch generation events, decoded; args keyed by the ABI input names, uint256 as decimal strings.';

-- Per-campaign state, recomputed from evm_campaign_events (never incremented).
create table if not exists public.evm_campaign_gen5_state (
  chain_id integer not null,
  campaign_address text not null,
  factory_address text,
  factory_generation integer,
  campaign_generation integer,
  graduation_stage text not null default 'trading',
  pending_trigger smallint,
  pending_since timestamptz,
  pending_block bigint,
  pending_raise_raw numeric(78,0),
  pending_native_target_raw numeric(78,0),
  pending_last_price_raw numeric(78,0),
  graduated_pool text,
  graduated_block bigint,
  graduated_at timestamptz,
  graduated_tx text,
  graduation_raise_raw numeric(78,0),
  protocol_share_raw numeric(78,0),
  creator_share_raw numeric(78,0),
  pool_native_raw numeric(78,0),
  meme_used_raw numeric(78,0),
  meme_burned_raw numeric(78,0),
  curve_price_raw numeric(78,0),
  start_price_raw numeric(78,0),
  repaired boolean,
  repair_steps integer not null default 0,
  repair_meme_sold_raw numeric(78,0) not null default 0,
  repair_proceeds_raw numeric(78,0) not null default 0,
  quote_token text,
  native_fallback boolean not null default false,
  native_fallback_adapter text,
  fallback_quote_held_raw numeric(78,0),
  fallback_quote_meme_sold_raw numeric(78,0),
  protocol_fee_escrowed_raw numeric(78,0) not null default 0,
  protocol_fee_flushed_raw numeric(78,0) not null default 0,
  creator_graduation_claimed_native_raw numeric(78,0) not null default 0,
  creator_graduation_claimed_quote_raw numeric(78,0) not null default 0,
  creator_first_buy_tokens_raw numeric(78,0),
  creator_first_buy_cost_raw numeric(78,0),
  creator_first_buy_fee_raw numeric(78,0),
  escrow_total_raw numeric(78,0) not null default 0,
  escrow_claimed_raw numeric(78,0) not null default 0,
  fee_vault text,
  fee_choice smallint,
  fee_creator_pct smallint,
  last_event_block bigint,
  updated_at timestamptz not null default now(),
  primary key (chain_id, campaign_address),
  constraint evm_campaign_gen5_state_stage_check check (graduation_stage in ('trading', 'pending', 'graduated')),
  constraint evm_campaign_gen5_state_choice_check check (fee_choice is null or fee_choice between 0 and 4)
);
create index if not exists evm_campaign_gen5_state_stage_idx
  on public.evm_campaign_gen5_state (chain_id, graduation_stage);
comment on table public.evm_campaign_gen5_state is
  'Gen-5 EVM campaign: graduation stage (trading/pending/graduated), C5 split, repair steps, E12 native fallback, escrowed protocol fee, creator escrow (C4) and fee choice (C6: 1 keep, 2 holders, 3 split, 4 buyback).';
comment on column public.evm_campaign_gen5_state.protocol_fee_escrowed_raw is
  'Sum of ProtocolGraduationFeeEscrowed; outstanding = escrowed - flushed (flushProtocolGraduationFee is permissionless).';

commit;

-- ===== 20260930_000002_evm_graduation_keeper.sql =====
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

-- ===== 20260930_000003_dex_trade_quote_leg_preserved.sql =====
-- (file has no begin/commit of its own; wrapped here)
begin;

-- Quote-bound EVM coins: keep a MEME/QUOTE trade's quote leg when its native columns carry the
-- native (BNB/ETH) value.
--
-- 202609080003 made set_dex_trade_quote_identity copy native_amount_raw into quote_amount_raw on
-- every insert, and read the quote token only from dex_pools.quote_token_address. That was right
-- while the pool indexers wrote the quote amount into native_amount_raw. They now write the native
-- value there (so price, market cap and volume are in native like every other coin) and write the
-- quote leg explicitly (quote_token_address, quote_amount_raw, quote_amount, price_quote). Copying
-- would overwrite the quote amount with the native one.
--
-- New behaviour:
--   * an explicit quote_token_address is kept; otherwise it comes from dex_pools (quote_token_address,
--     else the non-MEME side of token0/token1, which is what 202609080003 intended its generated
--     column to be -- on databases where the column already existed as a plain column it was never
--     filled for Topaz pools, and every Topaz insert raised);
--   * quote_amount_raw := native_amount_raw only when no quote amount was written or the quote is the
--     pool's wrapped native (native-paired pools: identical to before).
--
-- Replaces the function only. Where the trigger is attached (dex_trades_set_quote_identity) it takes
-- effect at once; where it is not attached this is inert. No data is rewritten.

create or replace function public.set_dex_trade_quote_identity()
returns trigger
language plpgsql
as $$
declare
  v_pool_quote text;
  v_wrapped text;
begin
  select coalesce(
           nullif(dp.quote_token_address,''),
           case
             when lower(dp.token0_address)=lower(dp.token_address) then dp.token1_address
             when lower(dp.token1_address)=lower(dp.token_address) then dp.token0_address
             else null
           end
         ),
         dp.wrapped_native_address
    into v_pool_quote, v_wrapped
    from public.dex_pools dp
   where dp.chain_id=new.chain_id
     and lower(dp.pair_address)=lower(new.pair_address)
   limit 1;

  if new.quote_token_address is null or new.quote_token_address='' then
    new.quote_token_address := v_pool_quote;
  end if;

  if new.quote_token_address is null or new.quote_token_address='' then
    raise exception 'DEX trade quote identity unavailable for chain %, pair %', new.chain_id, new.pair_address;
  end if;

  -- Native-paired pool: the quote leg is the native leg. A MEME/QUOTE writer sets quote_amount_raw.
  if new.quote_amount_raw is null
     or new.quote_amount_raw=''
     or lower(new.quote_token_address)=lower(coalesce(v_wrapped,'')) then
    new.quote_amount_raw := new.native_amount_raw;
  end if;
  return new;
end;
$$;

commit;

-- ===== 20260930_100001_campaign_draft_evm_launch_options.sql =====
-- EVM launch generation 6/5 (BNB 56, Robinhood 4663): the creator's first buy and fee choice saved on
-- a draft, so a scheduled arm signs exactly what the creator chose (docs/evm-launch C3, C6).
-- A side table, like campaign_draft_graduation_quote_selection: the shared campaign_drafts insert
-- (Solana and older EVM factories) is untouched, and a draft without a row keeps today's behaviour.
-- The on-chain factory still decides: the API only signs these for a generation 6 factory.
begin;

create table if not exists public.campaign_draft_evm_launch_options (
  draft_id uuid primary key references public.campaign_drafts(id) on delete cascade,
  chain_id integer not null,
  -- 1 keep / 2 holders / 3 split / 4 buyback (LaunchFactory FEE_CHOICE_*)
  fee_choice smallint not null,
  -- 1..99 for split, 0 otherwise (LaunchFactory._validateFeeChoice)
  fee_creator_pct smallint not null default 0,
  -- token units (18 decimals) the creator buys in the create transaction; 0 = none; <= 10% of supply
  first_buy_tokens numeric(78, 0) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_draft_evm_launch_options_chain_chk check (chain_id in (56, 97, 4663, 46630, 31337)),
  constraint campaign_draft_evm_launch_options_choice_chk check (fee_choice between 1 and 4),
  constraint campaign_draft_evm_launch_options_pct_chk check (
    (fee_choice = 3 and fee_creator_pct between 1 and 99) or (fee_choice <> 3 and fee_creator_pct = 0)
  ),
  constraint campaign_draft_evm_launch_options_first_buy_chk check (first_buy_tokens >= 0)
);

comment on table public.campaign_draft_evm_launch_options is
  'Generation 6 EVM create options per draft: fee choice and first-buy token amount. The first buy''s max cost is priced at arm time from the factory curve, never stored. Only signed for a factory reporting FACTORY_GENERATION >= 6.';

commit;

-- ===== 20260930_200001_evm_graduation_keeper_observations.sql =====
-- EVM graduation keeper step 6: after a campaign graduates into a Uniswap V3 pool (Robinhood), the keeper
-- calls pool.increaseObservationCardinalityNext(slots) once so the fail-closed TWAP reads have history.
-- That send is recorded like every other keeper send, with action 'observations'.
begin;

alter table public.evm_graduation_keeper_jobs
  drop constraint if exists evm_graduation_keeper_jobs_action_check;
alter table public.evm_graduation_keeper_jobs
  add constraint evm_graduation_keeper_jobs_action_check
    check (action in ('graduate', 'repair', 'native_fallback', 'flush', 'observations', 'harvest'));

comment on table public.evm_graduation_keeper_jobs is
  'EVM graduation keeper sends (graduate / repairPool / useNativeFallback / flushProtocolGraduationFee / pool increaseObservationCardinalityNext), recorded before broadcast.';

commit;

-- ===== 20260930_300001_evm_creator_choice_operator.sql =====
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
  -- Latest block timestamp when the job was signed: the vault's weekly caps and intervals run on chain time.
  chain_time bigint not null,
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

-- ===== 20260930_300002_evm_graduation_keeper_harvest.sql =====
-- EVM graduation keeper step 7: LP-fee harvest. For every pool registered in the generation's locker
-- (PermanentLpLocker on BNB, PermanentV3PositionLocker on Robinhood) the keeper calls
-- locker.harvest(pool) at most once per EVM_KEEPER_HARVEST_INTERVAL_SEC, only when fees are owed or MEME is
-- carried. Recorded before broadcast like every other keeper send, with action 'harvest'; call_args[0] is
-- the pool (lowercase), which is also how the interval is enforced across restarts.
begin;

alter table public.evm_graduation_keeper_jobs
  drop constraint if exists evm_graduation_keeper_jobs_action_check;
alter table public.evm_graduation_keeper_jobs
  add constraint evm_graduation_keeper_jobs_action_check
    check (action in ('graduate', 'repair', 'native_fallback', 'flush', 'observations', 'harvest'));

create index if not exists evm_graduation_keeper_jobs_harvest_pool_idx
  on public.evm_graduation_keeper_jobs (chain_id, (lower(call_args->>0)), created_at desc)
  where action = 'harvest';

comment on table public.evm_graduation_keeper_jobs is
  'EVM graduation keeper sends (graduate / repairPool / useNativeFallback / flushProtocolGraduationFee / pool increaseObservationCardinalityNext / locker harvest), recorded before broadcast.';

commit;
