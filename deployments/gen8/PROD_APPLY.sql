-- Gen-8 production SQL. Paste this into the PRODUCTION Supabase SQL editor
-- (project ellkfgoxnzykxqybajtn). Do not run it from a script.
-- Safe to run twice. Tables use IF NOT EXISTS, columns use ADD COLUMN IF NOT EXISTS,
-- and the market_trades_v patch leaves a view that already labels gen8_v4 alone.
-- Nothing here moves money. The indexer ignores these tables until the LIVE
-- gen-8 env is set.
-- Source: the four migrations on release/evm-gen8, same text as
-- docs/build_plans/evm-gen8-staging-sql/APPLY_STAGING.sql (staging already applied).


-- ===== 1/4 20261011_000010_evm_gen8_indexer.sql =====
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
  run_id bigint,                             -- the MwzFeeSplitter run (the rows between two claims to the splitter)
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

-- ===== 2/4 20261012_000011_evm_gen8_display.sql =====
-- Gen-8 hybrid ingestion (audit C-M5 / F10, founder 2026-10-12): display rows follow the chain head, money rows
-- only the safe / finalized block. Two small tables make a display rollback possible.
--   evm_gen8_display_blocks  block hashes of the display window (blocks with gen-8 logs, and the tip of every
--                            pass); pruned below the money cursor. A hash that no longer matches the chain is a
--                            reorg: the rows above the newest matching block are deleted and re-ingested.
--   evm_gen8_swaps           every gen-8 swap with what a candle and the stats need (spot price, market cap,
--                            volume, phase); after a rollback the affected candle buckets are rebuilt from it.
-- Idempotent.
create table if not exists public.evm_gen8_display_blocks (
  chain_id integer not null,
  hook_address text not null,
  block_number bigint not null,
  block_hash text not null,
  primary key (chain_id, hook_address, block_number)
);

create table if not exists public.evm_gen8_swaps (
  chain_id integer not null,
  hook_address text not null,
  pool_id text not null,
  token_address text not null,
  tx_hash text not null,
  log_index integer not null,
  block_number bigint not null,
  block_time timestamptz not null,
  phase text not null,
  side text not null,
  sqrt_price_x96 numeric(78,0) not null,
  price double precision not null,
  mcap double precision not null,
  volume double precision not null,
  sold_raw numeric(78,0),
  primary key (chain_id, tx_hash, log_index),
  constraint evm_gen8_swaps_phase_chk check (phase in ('bonding', 'post')),
  constraint evm_gen8_swaps_side_chk check (side in ('buy', 'sell'))
);
create index if not exists evm_gen8_swaps_token_idx on public.evm_gen8_swaps (chain_id, token_address, block_number, log_index);
create index if not exists evm_gen8_swaps_block_idx on public.evm_gen8_swaps (chain_id, hook_address, block_number);

-- ===== 3/4 20261012_000012_evm_gen8_open_at_phase.sql =====
-- Gen-8 contract fix round 2026-10-12 (build/evm-gen8 1fd147cb):
--   open_at     B scheduled open: when trading opens (Launched / PoolLaunched openAt; the launch block time when not
--               scheduled). The hook refuses swaps before it; the 60 s launch fee decay runs from it.
--   last_phase  F1: the pool's current phase from its last price ('post' at or past the graduation price, else
--               'bonding'; MwzLaunchLens.progress.postPhase). A coin counts as graduated for the platform only when
--               graduated_block is set AND last_phase = 'post'; a forced latch whose price fell back into range A
--               shows as bonding again.
-- Idempotent.
alter table public.evm_gen8_pools add column if not exists open_at timestamptz;
alter table public.evm_gen8_pools add column if not exists last_phase text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'evm_gen8_pools_last_phase_chk') then
    alter table public.evm_gen8_pools add constraint evm_gen8_pools_last_phase_chk check (last_phase is null or last_phase in ('bonding', 'post'));
  end if;
end $$;

-- ===== 4/4 20261011_000020_market_trades_v_gen8.sql =====
-- EVM generation 8 (step 4, 2026-10-11): market_trades_v labels gen-8 dex_trades rows as their own market.
--
-- The gen-8 indexer (realtime-indexer/src/evm/evmGen8Store.ts insertGen8DexTrade) writes post-graduation swaps of a
-- gen-8 coin to dex_trades with execution_source 'gen8_v4'. The view's dex branch labels every execution source it
-- does not know as TOPAZ / topaz, so those rows read as Topaz trades. This adds one branch to each of the two CASE
-- expressions, before the robinhood_v3 branch:
--   marketStage  WHEN t.execution_source = 'gen8_v4' THEN 'GEN8_V4'
--   source       WHEN t.execution_source = 'gen8_v4' THEN 'gen8_v4'
-- Every other row keeps its label.
--
-- Production and staging carry the view with different column types (production: tokenAmountRaw / nativeAmountRaw /
-- quoteAmountRaw numeric; staging: text; see 20260921_000002), so the view is not re-typed here: the current
-- definition is read with pg_get_viewdef, the two branches are inserted, and the same definition is replaced in place
-- (CREATE OR REPLACE keeps columns, types, grants and dependants). Its reloptions (security_invoker=true) are carried
-- over, because CREATE OR REPLACE VIEW resets options it is not given.
--
-- Idempotent: a view that already has the gen8_v4 branch is left alone. Refuses (raises) if either CASE is not found
-- exactly once, so it never writes a half-patched view. Rows with execution_source 'gen8_v4' exist only once the
-- gen-8 indexer runs (EVM_GEN8_LAUNCHER_<id> / EVM_GEN8_HOOK_<id>); before that this change has no visible effect.
do $$
declare
  def text;
  next_def text;
  opts text;
  stage_pat constant text := $p$(WHEN\s+\(?t\.execution_source\s*=\s*'robinhood_v3'::text\)?\s+THEN\s+'ROBINHOOD_V3'::text)$p$;
  source_pat constant text := $p$(WHEN\s+\(?t\.execution_source\s*=\s*'robinhood_v3'::text\)?\s+THEN\s+'robinhood_v3'::text)$p$;
  n_stage int;
  n_source int;
begin
  if to_regclass('public.market_trades_v') is null then
    raise notice 'market_trades_v does not exist; nothing to change';
    return;
  end if;
  def := pg_get_viewdef('public.market_trades_v'::regclass, true);
  if def ~ 'gen8_v4' then
    raise notice 'market_trades_v already labels gen8_v4; nothing to change';
    return;
  end if;
  select count(*) into n_stage from regexp_matches(def, stage_pat, 'g');
  select count(*) into n_source from regexp_matches(def, source_pat, 'g');
  if n_stage <> 1 or n_source <> 1 then
    raise exception 'market_trades_v: expected one robinhood_v3 branch in each CASE, found % / %', n_stage, n_source;
  end if;
  next_def := regexp_replace(def, stage_pat, $r$WHEN t.execution_source = 'gen8_v4'::text THEN 'GEN8_V4'::text \1$r$);
  next_def := regexp_replace(next_def, source_pat, $r$WHEN t.execution_source = 'gen8_v4'::text THEN 'gen8_v4'::text \1$r$);
  next_def := regexp_replace(next_def, ';\s*$', '');
  select array_to_string(reloptions, ', ') into opts from pg_class where oid = 'public.market_trades_v'::regclass;
  execute 'create or replace view public.market_trades_v'
    || case when coalesce(opts, '') <> '' then ' with (' || opts || ')' else '' end
    || ' as ' || next_def;
end $$;


-- ===== read-only check (safe to run twice, changes nothing) =====
select
  to_regclass('public.evm_gen8_pools') is not null as pools,
  to_regclass('public.evm_gen8_fee_accruals') is not null as accruals,
  to_regclass('public.evm_gen8_route_runs') is not null as route_runs,
  to_regclass('public.evm_gen8_side_pools') is not null as side_pools,
  to_regclass('public.evm_gen8_side_pool_volume') is not null as side_volume,
  to_regclass('public.evm_gen8_holder_exclusions') is not null as holder_exclusions,
  to_regclass('public.evm_gen8_display_blocks') is not null as display_blocks,
  to_regclass('public.evm_gen8_swaps') is not null as swaps,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'evm_gen8_pools' and column_name = 'open_at'
  ) as open_at,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'evm_gen8_pools' and column_name = 'last_phase'
  ) as last_phase,
  (pg_get_viewdef('public.market_trades_v'::regclass, true) ~ 'gen8_v4') as view_labels_gen8;
