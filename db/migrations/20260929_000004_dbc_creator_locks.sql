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
