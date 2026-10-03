BEGIN;

-- Reactions on creator updates (founder 2026-10-03): every coin post gets a linked social_posts row,
-- so rockets, reposts, quotes, replies, views and the post page run on the existing post machinery.
-- The linked row is never listed as a regular post (the API filters coin_post_id is null); the feed
-- keeps showing the coin post as a "Creator update" card with the linked row's counts.
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS coin_post_id bigint REFERENCES public.coin_posts(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS social_posts_coin_post_id_uidx
  ON public.social_posts (coin_post_id) WHERE coin_post_id IS NOT NULL;

-- Existing live creator updates get their linked row (same author, text, image, time; the coin as mention).
INSERT INTO public.social_posts (author_address, body, media_url, mentioned_chain_id, mentioned_token, status, created_at, coin_post_id)
SELECT cp.author_wallet, cp.body, cp.media_url, cp.chain_id, cp.token_address, 0, cp.created_at, cp.id
  FROM public.coin_posts cp
 WHERE cp.status = 0
   AND NOT EXISTS (SELECT 1 FROM public.social_posts sp WHERE sp.coin_post_id = cp.id);

COMMIT;
