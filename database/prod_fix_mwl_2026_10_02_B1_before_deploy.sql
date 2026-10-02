-- MWL fix B1 -- run on PRODUCTION (ellkfgoxnzykxqybajtn) BEFORE the API with the MWL rollover deploys.
--
-- Battle arena-muoo3g87-1efbe9 settled 2026-10-02 11:35 UTC and its points (Derpy Dave win 3,
-- BAWLS ONU loss 1) went into September (mwl-2026-m09-c101) because nothing rolled the month over.
-- This takes them out of September, so the rollover freezes September on its true standings
-- (ASK 3, Derpy Dave 1), and parks them in a holding table. B2 puts them into October.
-- The Q3 championship was not touched: its mirror trigger ignores events after 2026-10-01.
-- Every step checks the exact state it expects and aborts the whole transaction otherwise.
begin;

create table public.arena_mwl_rehome_20261002 as
  select * from public.arena_league_point_events
   where season_id = 'mwl-2026-m09-c101'
     and battle_id = 'arena-muoo3g87-1efbe9'
     and id in ('0541e22c-687c-4189-ba93-0ab0f69c2869', '0726f3b8-43ad-4068-9cff-dc16268150a8');

do $$
begin
  if (select count(*) from public.arena_mwl_rehome_20261002) <> 2 then
    raise exception 'expected exactly 2 point events to re-home';
  end if;
  if exists (select 1 from public.arena_league_seasons where id = 'mwl-2026-m09-c101' and finalized_at is not null) then
    raise exception 'September is already finalized: stop, the snapshot already includes these points';
  end if;
end $$;

delete from public.arena_league_point_events
 where id in (select id from public.arena_mwl_rehome_20261002);

-- Derpy Dave: 4 pts / 1W 1L / 2 fights -> 1 pt / 0W 1L / 1 fight (its 2026-09-26 loss stays).
-- BAWLS ONU: its only September row came from this battle.
do $$
declare n integer;
begin
  update public.arena_league_entries
     set points = points - 3, wins = wins - 1, finished_fights = finished_fights - 1
   where season_id = 'mwl-2026-m09-c101'
     and token_address = '2wT8AcQFEzXMEjb6qbs1GDg3mJ3DKBw6eBWp7GqsBAGS'
     and points = 4 and wins = 1 and losses = 1 and finished_fights = 2;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'Derpy Dave September entry is not in the expected state'; end if;

  delete from public.arena_league_entries
   where season_id = 'mwl-2026-m09-c101'
     and token_address = 'GAFQP8vSdDsHcjbBapN794CNEp5Wo6scqSDMSzDHpump'
     and points = 1 and wins = 0 and losses = 1 and finished_fights = 1;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'BAWLS ONU September entry is not in the expected state'; end if;
end $$;

-- Expect: ASK 3, Derpy Dave 1.
select token_name, points, wins, losses, finished_fights
  from public.arena_league_entries where season_id = 'mwl-2026-m09-c101' order by points desc;

commit;
