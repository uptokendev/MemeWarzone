-- DogeOS Barkswap (gen-8 on Algebra, chain 6281971): staging schema for the Barkswap rows.
-- docs/templar/specs/2026-10-14-dogeos-barkswap-launch-design.md section 3 "Money flow" / "Attribution for D1", section 4 Database.
--
-- Started by plan task t19 (the two conversion-bookkeeping tables below). Plan task t23 completes this file (side-pool
-- venue value, event kinds, the header note on 20261010) and its staging apply script. Idempotent; not run anywhere yet.
--
-- ---------------------------------------------------------------------------------------------------------- t19
-- Rows keep the gen-8 identity (plan global constraint "Row identity"): buys and the graduation fee are ordinary
-- evm_gen8_fee_accruals rows (hook_address = the plugin). Two things gen-8's V4 tables cannot hold:
--   1. a sell's fee is paid in coins and becomes DOGE only when the launcher converts the coin's pending coin fees,
--      in parts (every conversion draws the same fraction of every pending coin fee of that coin);
--   2. a part of one fee can land in a later route run than another part, so "one accrual row = one run" breaks.
-- So on Barkswap the route runs read evm_gen8_bark_credits (realtime-indexer/src/evm/evmGen8BarkAttribution.ts):
-- one row per DOGE amount a launcher log credited to the router bucket, attributed to the swap whose fee it is.

-- One row per Barkswap sell (its coin fee), written at the swap, never routed itself. expected_native is an estimate
-- for display (the router coins at the swap's fill price), never money; booked_* and converted_* are restated by the
-- attribution replay (absolute values, idempotent).
create table if not exists public.evm_gen8_bark_sell_fees (
  id bigserial primary key,
  chain_id integer not null,
  hook_address text not null,                -- the plugin
  tx_hash text not null,
  log_index integer not null,
  pool_id text not null,
  token_address text not null,
  block_number bigint not null,
  block_time timestamptz not null,
  phase text not null,                       -- BarkSwap.phase: bonding (crossing included) / post
  trader text,                               -- tx.from
  swap_sender text,
  profile text,                              -- bonding: the trader's profile at the swap; post: null
  gross_fee_coins numeric(78,0) not null,
  net_fee_coins numeric(78,0) not null,
  creator_coins numeric(78,0) not null,
  router_coins numeric(78,0) not null,       -- net - creator: what the plugin booked to the router coin book
  expected_native numeric(78,0) not null,    -- router_coins at the fill price (display only)
  booked_coins numeric(78,0),                -- router coins its collect booked (null until collected)
  collect_tx_hash text,
  collect_log_index integer,
  converted_coins numeric(78,0) not null default 0,
  converted_native numeric(78,0) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index),
  constraint evm_gen8_bark_sell_fees_phase_chk check (phase in ('bonding', 'post')),
  constraint evm_gen8_bark_sell_fees_profile_chk check (profile is null or profile in ('standard_linked', 'standard_unlinked', 'og_linked')),
  constraint evm_gen8_bark_sell_fees_nonneg_chk check (
    gross_fee_coins >= 0 and net_fee_coins >= 0 and creator_coins >= 0 and router_coins >= 0 and expected_native >= 0
    and (booked_coins is null or booked_coins >= 0) and converted_coins >= 0 and converted_native >= 0
  )
);
create index if not exists evm_gen8_bark_sell_fees_token_idx on public.evm_gen8_bark_sell_fees (chain_id, hook_address, token_address, block_number, log_index);

-- Router-bucket credits: the DOGE one launcher log (FeesCollected, CoinFeesConverted, GraduationFeeTaken) credited to
-- the router bucket, split by source: a buy covered by a collect, a converted part of a sell, the graduation fee, or
-- a surplus (Algebra rounding / unbooked fees: source = the crediting log or the collect that booked it, no trader).
-- Per log, the credits of a book add up to that log's book amount exactly; a route run is the unrouted credits before
-- the RouterClaimed that brought routerPaid(splitter) to expectedPaid. fee = router_amount = the credited DOGE, the
-- slice base (B11); block_time is the crediting log's, so a converted part counts in the epoch in which it converts.
create table if not exists public.evm_gen8_bark_credits (
  id bigserial primary key,
  chain_id integer not null,
  hook_address text not null,                -- the plugin (the gen-8 hook_address of the chain's rows)
  pool_id text not null,
  token_address text not null,
  tx_hash text not null,                     -- the crediting launcher log
  log_index integer not null,
  block_number bigint not null,
  block_time timestamptz not null,
  credit_kind text not null,                 -- collect / convert / graduation
  book text not null,                        -- router_bonding / router_post / graduation
  source_tx_hash text not null,              -- the swap whose fee it is (or see above)
  source_log_index integer not null,
  kind text not null,                        -- trade / graduation (as evm_gen8_fee_accruals)
  phase text not null,
  side text,
  trader text,
  swap_sender text,
  profile text,
  coins numeric(78,0) not null default 0,    -- convert: coins drawn from the source's pending coin fee
  fee numeric(78,0) not null,
  router_amount numeric(78,0) not null,
  league_weekly numeric(78,0) not null default 0,
  league_monthly numeric(78,0) not null default 0,
  recruiter numeric(78,0) not null default 0,
  squad numeric(78,0) not null default 0,
  airdrop numeric(78,0) not null default 0,
  protocol numeric(78,0) not null default 0,
  run_id bigint,                             -- the MwzBarkFeeSplitter run
  created_at timestamptz not null default now(),
  unique (chain_id, tx_hash, log_index, book, source_tx_hash, source_log_index),
  constraint evm_gen8_bark_credits_kind_chk check (credit_kind in ('collect', 'convert', 'graduation') and kind in ('trade', 'graduation')),
  constraint evm_gen8_bark_credits_book_chk check (book in ('router_bonding', 'router_post', 'graduation')),
  constraint evm_gen8_bark_credits_phase_chk check (phase in ('bonding', 'post')),
  constraint evm_gen8_bark_credits_side_chk check (side is null or side in ('buy', 'sell')),
  constraint evm_gen8_bark_credits_profile_chk check (profile is null or profile in ('standard_linked', 'standard_unlinked', 'og_linked')),
  constraint evm_gen8_bark_credits_nonneg_chk check (
    coins >= 0 and fee >= 0 and router_amount >= 0 and league_weekly >= 0 and league_monthly >= 0
    and recruiter >= 0 and squad >= 0 and airdrop >= 0 and protocol >= 0
  )
);
create index if not exists evm_gen8_bark_credits_unrouted_idx
  on public.evm_gen8_bark_credits (chain_id, hook_address, block_number, log_index) where run_id is null;
create index if not exists evm_gen8_bark_credits_run_idx on public.evm_gen8_bark_credits (chain_id, hook_address, run_id);
create index if not exists evm_gen8_bark_credits_source_idx on public.evm_gen8_bark_credits (chain_id, source_tx_hash, source_log_index);
-- ---------------------------------------------------------------------------------------------------------- end t19
