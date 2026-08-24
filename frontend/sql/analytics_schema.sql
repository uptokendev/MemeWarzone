-- Product analytics (first-party). Apply on the frontend-api Postgres (DATABASE_URL).
-- Out of scope: diagnostics, security audit log, finance amounts.
--
-- Security model:
--   * Tables live in public (Supabase default) but are NOT client-readable.
--   * RLS is ON with a deny-all policy for anon + authenticated.
--   * Grants are revoked from PUBLIC, anon, authenticated, AND service_role.
--     (service_role bypasses RLS in PostgREST; revoke is what actually blocks the Data API.)
--   * The Railway frontend-api uses DATABASE_URL (postgres superuser), which bypasses RLS.
--     That is the only reader/writer. Do not add a "read for authenticated" policy.
--   * Do not add these tables to supabase_realtime.

create extension if not exists pgcrypto;

create table if not exists public.analytics_events (
  event_id uuid primary key,
  ingested_at timestamptz not null default now(),
  ts timestamptz not null,
  name text not null,
  app text not null check (app in ('public', 'admin')),
  anonymous_id uuid not null,
  session_id uuid not null,
  user_id text,
  path_raw text,
  path_template text,
  properties jsonb not null default '{}'::jsonb,
  context jsonb not null default '{}'::jsonb
);

create index if not exists analytics_events_ts_app_idx
  on public.analytics_events (ts desc, app);
create index if not exists analytics_events_name_ts_idx
  on public.analytics_events (name, ts desc);
create index if not exists analytics_events_session_idx
  on public.analytics_events (session_id, ts);
create index if not exists analytics_events_anon_idx
  on public.analytics_events (anonymous_id, ts desc);
create index if not exists analytics_events_user_idx
  on public.analytics_events (user_id, ts desc)
  where user_id is not null;
create index if not exists analytics_events_path_idx
  on public.analytics_events (path_template, ts desc);

create table if not exists public.analytics_sessions (
  session_id uuid primary key,
  app text not null check (app in ('public', 'admin')),
  anonymous_id uuid not null,
  user_id text,
  started_at timestamptz not null,
  last_seen_at timestamptz not null,
  entry_path text,
  exit_path text,
  pageview_count integer not null default 0,
  event_count integer not null default 0
);

create index if not exists analytics_sessions_last_seen_idx
  on public.analytics_sessions (last_seen_at desc, app);
create index if not exists analytics_sessions_user_idx
  on public.analytics_sessions (user_id, last_seen_at desc)
  where user_id is not null;

create table if not exists public.analytics_hourly_pages (
  bucket timestamptz not null,
  app text not null,
  path_template text not null,
  views integer not null default 0,
  duration_ms_sum bigint not null default 0,
  duration_n integer not null default 0,
  primary key (bucket, app, path_template)
);

create table if not exists public.analytics_hourly_events (
  bucket timestamptz not null,
  app text not null,
  name text not null,
  count integer not null default 0,
  primary key (bucket, app, name)
);

create table if not exists public.analytics_hourly_functions (
  bucket timestamptz not null,
  app text not null,
  fn text not null,
  n integer not null default 0,
  ok_n integer not null default 0,
  duration_ms_sum bigint not null default 0,
  primary key (bucket, app, fn)
);

create table if not exists public.analytics_hourly_vitals (
  bucket timestamptz not null,
  app text not null,
  metric text not null,
  n integer not null default 0,
  value_sum double precision not null default 0,
  primary key (bucket, app, metric)
);

do $$
declare
  t text;
begin
  foreach t in array array[
    'analytics_events',
    'analytics_sessions',
    'analytics_hourly_pages',
    'analytics_hourly_events',
    'analytics_hourly_functions',
    'analytics_hourly_vitals'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    -- Not FORCE RLS: postgres / DATABASE_URL (superuser) must keep ingest+reads working.
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
