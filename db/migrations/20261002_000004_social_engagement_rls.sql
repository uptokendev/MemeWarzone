BEGIN;

-- Same second layer as social_posts (055c4a13): RLS on, no policies, so the Supabase REST roles
-- (anon, authenticated) read and write nothing. The API connects as the table owner and is unaffected.
-- Run after 20261001_000003_social_feed_engagement.sql.
ALTER TABLE public.social_post_fires ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_post_reposts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.social_feed_sessions ENABLE ROW LEVEL SECURITY;

COMMIT;
