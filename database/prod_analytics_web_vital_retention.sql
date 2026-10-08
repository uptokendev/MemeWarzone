-- Analytics retention: delete raw $web_vital events older than 14 days (production, founder runs it).
--
-- Order (do not skip ahead):
--   1. Apply db/migrations/20261008_000010_analytics_rollups.sql.
--   2. Deploy the API with the rollups, run the backfill on the API service once:
--        npm run cron:analytics-rollup -- --backfill
--      and add the hourly scheduled task (npm run cron:analytics-rollup, "7 * * * *").
--   3. Then this file. The vital counts and values of the deleted rows already live in
--      analytics_hourly_events and analytics_hourly_vital_values, so the dashboard numbers do not change.
--
-- Safety: the delete only touches hours that the rollup job has already built (inside
-- analytics_rollup_state) and that are older than both 14 days and the job's 8-day rebuild window.
-- If the state row is missing (backfill not run), it deletes nothing. Idempotent: run it again any time.
--
-- Supabase SQL editor: run each step on its own (select the statement, Run).

-- Step A. How many rows would go, and the covered range (read only).
select s.covered_from,
       s.covered_until,
       least(s.covered_until, date_trunc('day', now()) - interval '14 days') as delete_before,
       (select count(*)
          from public.analytics_events e
         where e.name = '$web_vital'
           and e.ts >= s.covered_from
           and e.ts < least(s.covered_until, date_trunc('day', now()) - interval '14 days')) as rows_to_delete
  from public.analytics_rollup_state s
 where s.name = 'hourly_rollups';

-- Step B. Delete one batch of 50,000 (uses analytics_events_name_ts_idx). Re-run until it reports
-- 0 rows affected. Each run is its own short transaction, so ingest is never blocked for long.
with doomed as (
  select e.event_id
    from public.analytics_events e
    join public.analytics_rollup_state s on s.name = 'hourly_rollups'
   where e.name = '$web_vital'
     and e.ts >= s.covered_from
     and e.ts < least(s.covered_until, date_trunc('day', now()) - interval '14 days')
   limit 50000
)
delete from public.analytics_events e
 using doomed d
 where e.event_id = d.event_id;

-- Step C. After the last batch, on its own (VACUUM cannot run inside a transaction block; if the
-- editor complains, run it from psql):
--   VACUUM (ANALYZE) public.analytics_events;
-- This makes the freed space reusable for new rows and refreshes the planner statistics. It does not
-- shrink the file on disk. To give the space back (about 400 MB of the 539 MB), run in a quiet window
--   VACUUM (FULL, ANALYZE) public.analytics_events;
-- which locks the table (ingest waits) for the duration, roughly a minute at this size.
--
-- Ongoing: run Steps B and C again weekly (or ask for a scheduled task). After the tracker fix the
-- table grows by a few thousand $web_vital rows per day instead of about 20,000.

-- No new index is needed: every rollup and retention query is served by the existing
-- analytics_events_ts_app_idx and analytics_events_name_ts_idx.
