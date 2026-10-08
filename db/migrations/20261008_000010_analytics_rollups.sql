BEGIN;

-- Analytics rollups (2026-10-08): makes the Command Center analytics pages fast.
-- Same tables as the block added to frontend/sql/analytics_schema.sql; either file can be applied.
-- Idempotent: safe to run twice. Same security model as the other analytics tables: RLS on with a
-- deny-all policy for anon + authenticated, no grants for PUBLIC / anon / authenticated / service_role.
-- The API (DATABASE_URL, table owner) is the only reader and writer.
--
-- After applying: deploy the API, then run the one-off backfill on the API service
--   npm run cron:analytics-rollup -- --backfill
-- and add the hourly Coolify scheduled task "7 * * * *": npm run cron:analytics-rollup

-- Job-built rollups (npm run cron:analytics-rollup). The admin analytics reads use them for the
-- finished hours inside analytics_rollup_state and read raw analytics_events for the rest, so the
-- numbers equal a raw query. See frontend/api/analytics/rollups.js.

-- Distinct visitors per hour (set, not a count, so a 7d / 30d distinct stays exact).
create table if not exists public.analytics_hourly_visitors (
  bucket timestamptz not null,
  app text not null,
  anonymous_id uuid not null,
  primary key (bucket, app, anonymous_id)
);

-- Distinct sessions per hour (the overview series).
create table if not exists public.analytics_hourly_sessions (
  bucket timestamptz not null,
  app text not null,
  session_id uuid not null,
  primary key (bucket, app, session_id)
);

-- Web vital values per hour with their multiplicity, so p50 / p75 / p95 over any window stay exact.
-- value is null for events without a measurement (counted in n, not in the percentiles).
create table if not exists public.analytics_hourly_vital_values (
  bucket timestamptz not null,
  app text not null,
  metric text not null,
  rating text not null default '',
  value double precision,
  n integer not null default 0
);

create index if not exists analytics_hourly_vital_values_bucket_idx
  on public.analytics_hourly_vital_values (bucket, app, metric);

-- The contiguous range of finished hours the job has built.
create table if not exists public.analytics_rollup_state (
  name text primary key,
  covered_from timestamptz not null,
  covered_until timestamptz not null,
  updated_at timestamptz not null default now()
);

do $$
declare
  t text;
begin
  foreach t in array array[
    'analytics_hourly_visitors',
    'analytics_hourly_sessions',
    'analytics_hourly_vital_values',
    'analytics_rollup_state'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists deny_clients on public.%I', t);
    execute format(
      'create policy deny_clients on public.%I for all to anon, authenticated using (false) with check (false)',
      t
    );
    execute format(
      'revoke all on table public.%I from public, anon, authenticated, service_role',
      t
    );
    execute format(
      'comment on table public.%I is %L',
      t,
      'API-only analytics. RLS on, no client/service_role grants. Railway DATABASE_URL is the only accessor.'
    );
  end loop;
end $$;

COMMIT;
