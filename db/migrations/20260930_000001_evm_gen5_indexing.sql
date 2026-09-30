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
