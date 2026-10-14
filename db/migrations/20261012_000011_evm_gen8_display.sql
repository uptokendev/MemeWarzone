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
