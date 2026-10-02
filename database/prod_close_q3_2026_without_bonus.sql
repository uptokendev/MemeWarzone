-- Close Q3 2026 without MWL placement bonuses (founder decision 2026-10-02). PRODUCTION.
-- Run AFTER db/migrations/20261002_000001_championship_mwl_transfer_waived.sql and after the API
-- carrying the 'waived' handling is live. The realtime worker then closes every Q3 championship
-- within a minute (log: "Quarterly Championship closed quarterly-championship-2026-q3-c…").
begin;

update public.arena_championship_mwl_transfers t
   set status = 'waived', applied_at = now()
  from public.arena_championship_epochs e
 where e.id = t.epoch_id
   and e.year = 2026 and e.quarter = 3
   and t.status = 'pending_policy';

-- Expect every Q3 row 'waived'.
select t.season_id, t.epoch_id, t.status
  from public.arena_championship_mwl_transfers t
  join public.arena_championship_epochs e on e.id = t.epoch_id
 where e.year = 2026 and e.quarter = 3;

commit;
