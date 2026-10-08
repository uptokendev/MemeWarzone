BEGIN;

-- Reactions on auto updates (founder 2026-10-08): launches, graduations, prepare pages and battles in the
-- feed get a linked social_posts row, keyed by the event, so views, rockets, reposts, quotes and
-- comments run on the existing post machinery (same pattern as coin_post_id for creator updates).
-- The linked row is never listed as a regular post (the API filters system_event_key is null); the feed
-- keeps showing the auto update card with the linked row's counts. Rows are created on first view.
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS system_event_key text;

CREATE UNIQUE INDEX IF NOT EXISTS social_posts_system_event_key_uidx
  ON public.social_posts (system_event_key) WHERE system_event_key IS NOT NULL;

COMMIT;
