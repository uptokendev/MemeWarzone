-- Additive V1 envelope columns on MWZ notification_outbox.
-- Safe if the Discord-bot Supabase already applied the same names.

alter table public.notification_outbox
  add column if not exists schema_version integer not null default 1;

alter table public.notification_outbox
  add column if not exists chain_id text;

alter table public.notification_outbox
  add column if not exists environment text;

alter table public.notification_outbox
  add column if not exists entity_type text;

alter table public.notification_outbox
  add column if not exists entity_id text;
