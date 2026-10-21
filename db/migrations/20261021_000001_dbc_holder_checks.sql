-- Hold-through holder rule for DBC holders / split coins (founder, 2026-10-21), weeks from 2026-10-26 on.
-- Four secret checks per week, one in each quarter. A wallet counts only if it held at least 0.01% of
-- the supply at every check, with its lowest balance. The indexer (dbcCreatorPayouts.ts) writes one
-- check per row set here and, once the week is over, settles them into dbc_holder_snapshots, which the
-- weekly holder round reads as before. Additive only: no existing table or row changes.

create table if not exists public.dbc_holder_checks (
  week_id text not null,
  mint text not null,
  check_index smallint not null,
  owner text not null,
  amount numeric not null,
  primary key (week_id, mint, check_index, owner)
);

create table if not exists public.dbc_holder_check_runs (
  week_id text not null,
  mint text not null,
  check_index smallint not null,
  pool text not null,
  taken_at timestamptz not null default now(),
  slot bigint,
  supply numeric not null,
  holders integer not null,
  primary key (week_id, mint, check_index)
);

-- Indexer only. Without this, the public anon key could insert a wallet into a check before the
-- indexer writes it (the indexer inserts with on conflict do nothing), or read which checks are done.
alter table public.dbc_holder_checks enable row level security;
alter table public.dbc_holder_check_runs enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.dbc_holder_checks, public.dbc_holder_check_runs from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.dbc_holder_checks, public.dbc_holder_check_runs to service_role;
  end if;
end $$;
