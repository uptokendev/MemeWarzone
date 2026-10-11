-- EVM generation 8 (Uniswap V4 pool with the MemeWarzone hook), indexer step 3 (2026-10-11).
-- docs/evm-launch/EVM_GEN8_V4_DESIGN.md 6.3 / 6.5 / 6.8 and 3.4 (D1); GEN8_INTERNAL_AUDIT.md 10.1 / 10.2.
-- Additive and idempotent (safe to run twice). Nothing reads these tables until EVM_GEN8_LAUNCHER_<id> and
-- EVM_GEN8_HOOK_<id> are set on the indexer. RLS on, no policies (indexer and API run as the table owner), as
-- moderation_holds. Nothing here moves money.
begin;

-- One row per gen-8 pool (coin). campaign_address everywhere else = the coin's token address.
create table if not exists public.evm_gen8_pools (
  chain_id integer not null,
  pool_id text not null,                     -- bytes32, lower-case 0x hex
  token_address text not null,
  hook_address text not null,
  launcher_address text not null,
  pool_manager_address text not null,
  creator_address text not null,             -- the human creator (Launched.creator), follows CreatorTransferred
  hook_creator_address text,                 -- Launched.hookCreator (the choice vault for choice coins)
  creator_profile text,                      -- recruiter profile of the creator at launch (graduation fee attribution)
  fee_choice smallint,
  fee_creator_pct smallint,
  target_usd numeric(78,0),
  market_cap_native numeric(78,0),
  virtual_native numeric(78,0),
  virtual_token numeric(78,0),
  tick_start integer not null,
  tick_grad integer not null,
  liq_a numeric(78,0) not null,
  liq_b numeric(78,0) not null,
  fees jsonb not null default '{}'::jsonb,   -- PoolLaunched.fees (bps)
  display_pair text,                         -- BNB display pair (V2 events for DexScreener), null on Robinhood
  first_buy_in numeric(78,0),
  first_buy_out numeric(78,0),
  launch_tx text not null,
  launch_block bigint not null,
  launch_time timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  last_sqrt_price_x96 numeric(78,0),
  last_tick integer,
  last_liquidity numeric(78,0),
  last_swap_block bigint,
  last_swap_log_index integer,
  graduated_block bigint,
  graduated_tx text,
  graduated_log_index integer,
  grad_fee_native numeric(78,0),
  native_in_a numeric(78,0),
  holder_count integer,
  holders_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chain_id, pool_id),
  constraint evm_gen8_pools_profile_chk check (creator_profile is null or creator_profile in ('standard_linked', 'standard_unlinked', 'og_linked'))
);
create unique index if not exists evm_gen8_pools_token_uidx on public.evm_gen8_pools (chain_id, token_address);
create index if not exists evm_gen8_pools_hook_idx on public.evm_gen8_pools (chain_id, hook_address);

-- D1 accruals: one row per HookFee (kind 'trade') and per Graduated (kind 'graduation'). Idempotent on the log.
-- Slices are the per-trade attribution (floors per row); route runs use aggregate sums (evmGen8Fees.ts).
create table if not exists public.evm_gen8_fee_accruals (
  id bigserial primary key,
  chain_id integer not null,
  hook_address text not null,
  pool_id text not null,
  token_address text not null,
  tx_hash text not null,
  log_index integer not null,
  swap_log_index integer,
  block_number bigint not null,
  block_time timestamptz not null,
  kind text not null,
  phase text not null,
  trader text,                               -- tx.from (trade) or the creator (graduation)
  swap_sender text,
  referrer text,                             -- hookData word: analytics only, never money
  side text,
  profile text,
  curve_amount numeric(78,0) not null default 0,
  fee numeric(78,0) not null,
  fee_bps integer,
  creator_share numeric(78,0) not null default 0,
  router_amount numeric(78,0) not null,
  league_weekly numeric(78,0) not null default 0,
  league_monthly numeric(78,0) not null default 0,
  recruiter numeric(78,0) not null default 0,
  squad numeric(78,0) not null default 0,
  airdrop numeric(78,0) not null default 0,
  protocol numeric(78,0) not null default 0,
  run_id bigint,                             -- the MwzFeeSplitter run whose claim covered this fee
  run_late boolean not null default false,   -- covered by the run's claim but not in its accrualRoot
  created_at timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index),
  constraint evm_gen8_fee_accruals_kind_chk check (kind in ('trade', 'graduation')),
  constraint evm_gen8_fee_accruals_phase_chk check (phase in ('bonding', 'post')),
  constraint evm_gen8_fee_accruals_side_chk check (side is null or side in ('buy', 'sell')),
  constraint evm_gen8_fee_accruals_profile_chk check (profile is null or profile in ('standard_linked', 'standard_unlinked', 'og_linked')),
  constraint evm_gen8_fee_accruals_nonneg_chk check (
    fee >= 0 and creator_share >= 0 and router_amount >= 0 and league_weekly >= 0 and league_monthly >= 0
    and recruiter >= 0 and squad >= 0 and airdrop >= 0 and protocol >= 0
  )
);
create index if not exists evm_gen8_fee_accruals_unrouted_idx
  on public.evm_gen8_fee_accruals (chain_id, hook_address, block_number, log_index) where run_id is null;
create index if not exists evm_gen8_fee_accruals_run_idx on public.evm_gen8_fee_accruals (chain_id, hook_address, run_id);
create index if not exists evm_gen8_fee_accruals_token_idx on public.evm_gen8_fee_accruals (chain_id, token_address, block_number);

-- Splitter runs. status: dry_run (plan only, rewritten each pass), sent, confirmed (Routed indexed), failed.
create table if not exists public.evm_gen8_route_runs (
  chain_id integer not null,
  splitter_address text not null,
  run_id bigint not null,
  status text not null,
  plan_block bigint,
  total numeric(78,0),
  bonding_fees numeric(78,0),
  grad_fees numeric(78,0),
  weekly_league numeric(78,0),
  monthly_league numeric(78,0),
  recruiter numeric(78,0),
  squad numeric(78,0),
  airdrop numeric(78,0),
  protocol numeric(78,0),
  rounding_airdrop numeric(78,0) not null default 0,
  carried jsonb not null default '{}'::jsonb,
  accrual_root text,
  leaf_count integer,
  leaves jsonb,                              -- the planned leaf rows (for anyone recomputing the root)
  tx_hash text,
  routed_block bigint,
  routed_log_index integer,
  caller text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chain_id, splitter_address, run_id),
  constraint evm_gen8_route_runs_status_chk check (status in ('dry_run', 'sent', 'confirmed', 'failed'))
);

-- Side pools (6.8): pools of our coins that do not use our hook. Never counted anywhere; alerts only.
create table if not exists public.evm_gen8_side_pools (
  chain_id integer not null,
  pool_key text not null,                    -- pair / pool address, or the V4 / Infinity CL pool id
  token_address text not null,
  venue text not null,                       -- v2 | v3 | v3_pancake | solidly | v4 | infinity_cl
  factory_address text not null,             -- factory, or the PoolManager (v4) / CLPoolManager (infinity_cl)
  other_token text,
  fee integer,
  hooks text,
  created_block bigint not null,
  created_tx text,
  coin_volume_raw_total numeric(78,0) not null default 0,
  swaps_total integer not null default 0,
  last_swap_block bigint,
  last_swap_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (chain_id, pool_key),
  constraint evm_gen8_side_pools_venue_chk check (venue in ('v2', 'v3', 'v3_pancake', 'solidly', 'v4', 'infinity_cl'))
);
create index if not exists evm_gen8_side_pools_token_idx on public.evm_gen8_side_pools (chain_id, token_address);

create table if not exists public.evm_gen8_side_pool_volume (
  chain_id integer not null,
  pool_key text not null,
  hour timestamptz not null,
  coin_volume_raw numeric(78,0) not null default 0,
  swaps integer not null default 0,
  primary key (chain_id, pool_key, hour)
);

-- Holder census exclusions per chain (PoolManager, hook, 0xdEaD, launcher, reserve lock, escrow, choice vault,
-- PancakeSwap Infinity Vault, and every side-pool contract the watcher finds).
create table if not exists public.evm_gen8_holder_exclusions (
  chain_id integer not null,
  wallet text not null,
  reason text not null,
  updated_at timestamptz not null default now(),
  primary key (chain_id, wallet)
);

-- Hook / launcher / splitter / choice-vault events land in evm_campaign_events like the gen-5 contracts.
alter table public.evm_campaign_events drop constraint if exists evm_campaign_events_kind_check;
alter table public.evm_campaign_events add constraint evm_campaign_events_kind_check
  check (contract_kind in ('campaign', 'factory', 'router', 'creator_vault', 'lp_locker',
                           'gen8_hook', 'gen8_launcher', 'gen8_splitter', 'gen8_choice_vault'));

alter table public.evm_gen8_pools enable row level security;
alter table public.evm_gen8_fee_accruals enable row level security;
alter table public.evm_gen8_route_runs enable row level security;
alter table public.evm_gen8_side_pools enable row level security;
alter table public.evm_gen8_side_pool_volume enable row level security;
alter table public.evm_gen8_holder_exclusions enable row level security;
revoke all on public.evm_gen8_pools from anon, authenticated;
revoke all on public.evm_gen8_fee_accruals from anon, authenticated;
revoke all on public.evm_gen8_route_runs from anon, authenticated;
revoke all on public.evm_gen8_side_pools from anon, authenticated;
revoke all on public.evm_gen8_side_pool_volume from anon, authenticated;
revoke all on public.evm_gen8_holder_exclusions from anon, authenticated;

commit;
