BEGIN;

-- Post views (founder, 2026-10-02). One row per viewer per post: viewer_key is the wallet (EVM
-- lowercased, Solana base58) or an anonymous browser id "anon:<uuid>". A view is counted when a post
-- card has been on screen for about a second or its thread is opened. RLS on, no policies: only the
-- API (table owner) reads and writes.
CREATE TABLE IF NOT EXISTS public.social_post_views (
  post_id     bigint NOT NULL REFERENCES public.social_posts(id) ON DELETE CASCADE,
  viewer_key  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, viewer_key),
  CONSTRAINT social_post_views_viewer_key_len CHECK (char_length(viewer_key) BETWEEN 8 AND 80)
);

ALTER TABLE public.social_post_views ENABLE ROW LEVEL SECURITY;

COMMIT;
