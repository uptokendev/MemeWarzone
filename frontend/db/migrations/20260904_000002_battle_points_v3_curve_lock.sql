begin;

create table if not exists public.arena_battle_scoring_locks (
  battle_id text primary key references public.arena_battles(id) on delete cascade,
  scoring_version text not null,
  boost_curve_version text not null,
  boost_curve_parameters jsonb not null,
  locked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint arena_battle_scoring_locks_v3 check (
    scoring_version = 'battle_points_v3'
    and boost_curve_version = 'boost_hyperbolic_100_v1'
    and boost_curve_parameters = '{"maxPoints":10,"halfSaturationUnits":100,"unitUsdMicros":1000000}'::jsonb
  )
);

create or replace function public.prevent_arena_battle_scoring_lock_mutation()
returns trigger
language plpgsql
as $$
begin
  if new.battle_id is distinct from old.battle_id
     or new.scoring_version is distinct from old.scoring_version
     or new.boost_curve_version is distinct from old.boost_curve_version
     or new.boost_curve_parameters is distinct from old.boost_curve_parameters
     or new.locked_at is distinct from old.locked_at then
    raise exception 'arena battle scoring lock is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists arena_battle_scoring_lock_immutable on public.arena_battle_scoring_locks;
create trigger arena_battle_scoring_lock_immutable
before update on public.arena_battle_scoring_locks
for each row execute function public.prevent_arena_battle_scoring_lock_mutation();

create index if not exists arena_battle_scoring_locks_version_idx
  on public.arena_battle_scoring_locks(scoring_version, boost_curve_version, locked_at);

commit;
