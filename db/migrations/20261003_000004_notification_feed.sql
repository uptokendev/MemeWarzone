-- CO-5: one bell feed for every notification category (battles, social, rewards, coin).
-- The bell already reads public.prepare_mode_notifications (draft and promotion events); every new
-- producer writes there too, so the response shape and usePrepareNotificationCenter stay as they are.
--   category    battles | social | rewards | coin (existing rows are coin: draft and promotion events)
--   dedupe_key  one notification per wallet per event, so every producer can safely run again
--   emailed_at  set once the hourly digest has handled the row (mailed, or skipped: no email / off)
-- Staging first; production is run by the founder in the Supabase SQL editor. Idempotent.

begin;

alter table public.prepare_mode_notifications add column if not exists category text not null default 'coin';
alter table public.prepare_mode_notifications add column if not exists dedupe_key text;
-- emailed_at: added once, and only then are the existing rows marked handled (the first digest must
-- not mail months of old draft notices). Re-running never touches rows the digest has yet to send.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'prepare_mode_notifications' and column_name = 'emailed_at'
  ) then
    alter table public.prepare_mode_notifications add column emailed_at timestamptz;
    update public.prepare_mode_notifications set emailed_at = now();
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'prepare_mode_notifications_category_check'
  ) then
    alter table public.prepare_mode_notifications
      add constraint prepare_mode_notifications_category_check
      check (category in ('battles', 'social', 'rewards', 'coin'));
  end if;
end $$;

create unique index if not exists prepare_mode_notifications_dedupe_idx
  on public.prepare_mode_notifications (wallet_address, dedupe_key)
  where dedupe_key is not null;

create index if not exists prepare_mode_notifications_digest_idx
  on public.prepare_mode_notifications (created_at)
  where emailed_at is null;

commit;
