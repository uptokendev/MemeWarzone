\set ON_ERROR_STOP on
create extension if not exists pgcrypto;

create table if not exists public.campaigns (
  chain_id integer not null,
  campaign_address text not null,
  token_address text,
  creator_address text not null default '',
  factory_address text,
  name text,
  symbol text,
  meta jsonb not null default '{}'::jsonb,
  created_block bigint not null default 0,
  created_at_chain timestamptz,
  graduated_block bigint,
  graduated_at_chain timestamptz,
  is_active boolean not null default true,
  bonding_active boolean not null default true,
  support_enabled boolean not null default true,
  indexing_enabled boolean not null default true,
  market_stage text not null default 'BONDING',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(chain_id,campaign_address)
);
create table if not exists public.indexer_state (
  chain_id integer not null,
  cursor text not null,
  last_indexed_block bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key(chain_id,cursor)
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
  amount_in_wei numeric(78,0), amount_out_wei numeric(78,0), cost_wei numeric(78,0), payout_wei numeric(78,0),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(chain_id,tx_hash,log_index)
);
create table if not exists public.user_coin_edges (
  chain_id integer not null,user_address text not null,campaign_address text not null,token_address text,reason text not null,
  first_seen_block bigint,first_seen_time timestamptz,last_seen_block bigint,updated_at timestamptz not null default now(),
  primary key(chain_id,user_address,campaign_address,reason)
);
create table if not exists public.curve_trades (
  chain_id integer not null,campaign_address text not null,tx_hash text not null,log_index integer not null,
  block_number bigint not null,block_time timestamptz not null,side text not null,wallet text not null,
  token_amount_raw numeric(78,0) not null,bnb_amount_raw numeric(78,0) not null,
  token_amount double precision,bnb_amount double precision,price_bnb double precision,sold_tokens_after_raw numeric(78,0),
  created_at timestamptz not null default now(),primary key(chain_id,tx_hash,log_index)
);
create table if not exists public.token_candles (
  chain_id integer not null,campaign_address text not null,timeframe text not null,bucket_start timestamptz not null,
  o double precision not null,h double precision not null,l double precision not null,c double precision not null,
  volume_bnb numeric not null default 0,trades_count integer not null default 0,source_mask smallint not null default 1,
  bonding_trade_count integer not null default 0,dex_trade_count integer not null default 0,
  bonding_volume_bnb numeric not null default 0,dex_volume_bnb numeric not null default 0,
  last_block_number bigint,last_log_index integer,
  price_o numeric,price_h numeric,price_l numeric,price_c numeric,mcap_o numeric,mcap_h numeric,mcap_l numeric,mcap_c numeric,
  canonical_version integer not null default 0,canonical_updated_at timestamptz,updated_at timestamptz not null default now(),
  primary key(chain_id,campaign_address,timeframe,bucket_start)
);
create table if not exists public.token_stats (
  chain_id integer not null,campaign_address text not null,last_price_bnb double precision,sold_tokens double precision not null default 0,
  marketcap_bnb double precision,vol_24h_bnb double precision not null default 0,updated_at timestamptz not null default now(),
  primary key(chain_id,campaign_address)
);
create table if not exists public.campaign_activity (
  chain_id integer not null,campaign_address text not null,last_activity_at timestamptz,updated_at timestamptz not null default now(),
  primary key(chain_id,campaign_address)
);
create table if not exists public.campaign_market_state (
  chain_id integer not null,campaign_address text not null,token_address text not null,market_stage text not null default 'BONDING',
  dex_pair_address text,pool_verified boolean not null default false,indexing_enabled boolean not null default true,
  primary key(chain_id,campaign_address)
);
create table if not exists public.dex_pools (
  chain_id integer not null,pair_address text not null,campaign_address text not null,token_address text not null,wrapped_native_address text not null,
  router_address text not null default '',factory_address text not null default '',factory_generation text,token0_address text not null,token1_address text not null,
  stable boolean not null default false,fee_bps integer not null default 30,deployment_block bigint,graduation_block bigint not null,
  support_enabled boolean not null default true,indexing_enabled boolean not null default true,last_indexed_block bigint,last_finalized_block bigint,
  last_swap_at timestamptz,last_sync_at timestamptz,reserve_token_raw text,reserve_native_raw text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  primary key(chain_id,pair_address)
);
create table if not exists public.trade_intents (
  intent_id uuid primary key default gen_random_uuid(),chain_id integer not null,campaign_address text not null,pair_address text,wallet_address text not null,
  side text not null,amount_in_raw text not null,minimum_out_raw text not null,quoted_out_raw text not null,slippage_bps integer not null,quote_block bigint not null,
  expires_at timestamptz not null,transaction_hash text,status text not null default 'quoted',created_at timestamptz not null default now(),confirmed_at timestamptz,updated_at timestamptz not null default now()
);
create table if not exists public.dex_trades (
  chain_id integer not null,campaign_address text not null,token_address text not null,pair_address text not null,tx_hash text not null,log_index integer not null,
  block_number bigint not null,block_hash text not null,block_time timestamptz not null,status text not null default 'confirmed',side text not null,
  sender_address text,recipient_address text,transaction_from text,token_amount_raw text not null,native_amount_raw text not null,
  token_amount numeric,native_amount numeric,price_bnb numeric,execution_source text not null default 'topaz_v2',origin text not null default 'unknown',trade_intent_id uuid,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(chain_id,tx_hash,log_index)
);
create table if not exists public.market_stats (
  chain_id integer not null,campaign_address text not null,market_stage text not null default 'BONDING',last_price_bnb numeric,market_cap_bnb numeric,liquidity_bnb numeric,bonding_reserve_bnb numeric,
  volume_5m_bnb numeric not null default 0,volume_1h_bnb numeric not null default 0,volume_4h_bnb numeric not null default 0,volume_24h_bnb numeric not null default 0,
  buy_volume_24h_bnb numeric not null default 0,sell_volume_24h_bnb numeric not null default 0,bonding_volume_24h_bnb numeric not null default 0,dex_volume_24h_bnb numeric not null default 0,
  trades_24h integer not null default 0,buys_24h integer not null default 0,sells_24h integer not null default 0,holders integer,post_burn_total_supply_raw text,supply_basis text,last_trade_block bigint,last_trade_at timestamptz,data_lag_seconds integer,updated_at timestamptz not null default now(),
  primary key(chain_id,campaign_address)
);
create table if not exists public.solana_fee_escrow_events (
  chain_id integer not null,tx_hash text not null,log_index integer not null,event_kind text not null,campaign_address text,escrow_address text,
  weekly_raw numeric(78,0) not null default 0,monthly_raw numeric(78,0) not null default 0,recruiter_raw numeric(78,0) not null default 0,airdrop_raw numeric(78,0) not null default 0,squad_raw numeric(78,0) not null default 0,protocol_raw numeric(78,0) not null default 0,total_raw numeric(78,0) not null default 0,created_at timestamptz not null default now(),
  primary key(chain_id,tx_hash,log_index,event_kind)
);
create table if not exists public.solana_fee_escrow_accruals (
  chain_id integer not null,campaign_address text not null,escrow_address text,init_status text,init_signature text,
  weekly_accrued numeric(78,0) not null default 0,monthly_accrued numeric(78,0) not null default 0,recruiter_accrued numeric(78,0) not null default 0,airdrop_accrued numeric(78,0) not null default 0,squad_accrued numeric(78,0) not null default 0,protocol_accrued numeric(78,0) not null default 0,
  weekly_flushed numeric(78,0) not null default 0,monthly_flushed numeric(78,0) not null default 0,recruiter_flushed numeric(78,0) not null default 0,airdrop_flushed numeric(78,0) not null default 0,squad_flushed numeric(78,0) not null default 0,protocol_flushed numeric(78,0) not null default 0,
  first_accrued_at timestamptz,last_accrued_at timestamptz,last_flush_at timestamptz,last_flush_signature text,flush_status text,updated_at timestamptz not null default now(),
  primary key(chain_id,campaign_address)
);
create table if not exists public.solana_fee_escrow_init_queue (
  chain_id integer not null,campaign_address text not null,status text not null default 'queued',attempts integer not null default 0,last_error text,next_attempt_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),primary key(chain_id,campaign_address)
);
