-- MWL fix B2 -- run on PRODUCTION after B1 AND after the API with the rollover is live, i.e. once
-- mwl-2026-m10-c101 exists and is active (API log: "MWL rollover finalized mwl-2026-m09-c101 ...
-- opened=mwl-2026-m10-c101"). Puts the 2026-10-02 battle's points into October. Inserting the events
-- fires the existing mirror trigger, which credits the Q4 championship as it would have on the day.
begin;

do $$
begin
  if not exists (select 1 from public.arena_league_seasons where id = 'mwl-2026-m10-c101' and active) then
    raise exception 'mwl-2026-m10-c101 is not open yet: wait for the rollover';
  end if;
  if (select count(*) from public.arena_mwl_rehome_20261002) <> 2 then
    raise exception 'holding table does not hold the 2 events from B1';
  end if;
  if exists (select 1 from public.arena_league_point_events
              where season_id = 'mwl-2026-m10-c101' and battle_id = 'arena-muoo3g87-1efbe9') then
    raise exception 'October already has this battle: B2 already ran';
  end if;
end $$;

-- Entries first (the mirror trigger reads the name from them). Adds to a row a later October battle
-- may already have created.
insert into public.arena_league_entries
  (season_id, token_id, token_address, token_name, symbol, points, wins, losses, finished_fights)
values
  ('mwl-2026-m10-c101', '2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS', '2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS', 'Derpy Dave', 'DERPYDAVE', 3, 1, 0, 1),
  ('mwl-2026-m10-c101', 'GAFQP8vSdDsHcjbBapN794CNEp5Wo6scqSDMSzDHpump', 'GAFQP8vSdDsHcjbBapN794CNEp5Wo6scqSDMSzDHpump', 'BAWLS ONU', 'BAWLS', 1, 0, 1, 1)
on conflict (season_id, token_address) do update
  set points = public.arena_league_entries.points + excluded.points,
      wins = public.arena_league_entries.wins + excluded.wins,
      losses = public.arena_league_entries.losses + excluded.losses,
      finished_fights = public.arena_league_entries.finished_fights + excluded.finished_fights;

-- Same ids and timestamps as the originals.
insert into public.arena_league_point_events
  (id, season_id, token_address, kind, points, wallet, battle_id, pair_key, utc_day, metadata, created_at)
select id, 'mwl-2026-m10-c101', token_address, kind, points, wallet, battle_id, pair_key, utc_day, metadata, created_at
  from public.arena_mwl_rehome_20261002;

drop table public.arena_mwl_rehome_20261002;

-- Expect Derpy Dave 3 / BAWLS ONU 1 in October, and the same two in the Q4 championship.
select token_name, points, wins, losses, finished_fights
  from public.arena_league_entries where season_id = 'mwl-2026-m10-c101' order by points desc;
select token_address, base_points from public.arena_championship_entries
 where epoch_id = 'quarterly-championship-2026-q4-c101';

commit;
