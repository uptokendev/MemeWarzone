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

-- Final founder-approved Battle Points V3 generation. Historical V2 is stored
-- separately and is not rewritten by this migration.
alter table if exists public.arena_battle_points_v3
  alter column mcap_weight set default 45,
  alter column holder_weight set default 27,
  alter column volume_weight set default 18,
  alter column boost_weight set default 10,
  alter column boost_curve_version set default 'boost_hyperbolic_100_v1',
  alter column boost_curve_parameters set default '{"maxPoints":10,"halfSaturationUnits":100,"unitUsdMicros":1000000}'::jsonb;

-- The prior V3 scaffold was never founder-activated, so every V3 projection is
-- normalized to the one authoritative generation. Historical V2 rows are not in
-- this table/scoring version and are unaffected.
update public.arena_battle_points_v3
   set mcap_weight = 45,
       holder_weight = 27,
       volume_weight = 18,
       boost_weight = 10
 where scoring_version = 'battle_points_v3'
   and (mcap_weight, holder_weight, volume_weight, boost_weight) is distinct from (45, 27, 18, 10);

-- Curve identity becomes authoritative only where an immutable per-Battle V3
-- lock already exists. Unlocked historical scaffold rows remain non-authoritative.
update public.arena_battle_points_v3 p
   set boost_curve_version = l.boost_curve_version,
       boost_curve_parameters = l.boost_curve_parameters
  from public.arena_battle_scoring_locks l
 where p.battle_id = l.battle_id
   and p.scoring_version = 'battle_points_v3'
   and p.boost_curve_version = 'founder_pending';

commit;
