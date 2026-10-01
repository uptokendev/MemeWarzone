-- Feed engagement (founder, 2026-10-01): 1000-char posts, replies, Fire, Repost,
-- and a signed session so Fire/Repost/Reply do not pop the wallet every click.
-- Additive. social_posts already exists from 20261001_000002.
BEGIN;

ALTER TABLE public.social_posts
  DROP CONSTRAINT IF EXISTS social_posts_body_max;
ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_body_max CHECK (char_length(body) <= 1000);

ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS parent_id bigint REFERENCES public.social_posts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS social_posts_parent_created_idx
  ON public.social_posts (parent_id, created_at ASC)
  WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.social_post_fires (
  post_id         bigint NOT NULL REFERENCES public.social_posts(id) ON DELETE CASCADE,
  author_address  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, author_address)
);

CREATE INDEX IF NOT EXISTS social_post_fires_author_created_idx
  ON public.social_post_fires (author_address, created_at DESC);

CREATE TABLE IF NOT EXISTS public.social_post_reposts (
  post_id         bigint NOT NULL REFERENCES public.social_posts(id) ON DELETE CASCADE,
  author_address  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, author_address)
);

CREATE INDEX IF NOT EXISTS social_post_reposts_author_created_idx
  ON public.social_post_reposts (author_address, created_at DESC);

CREATE TABLE IF NOT EXISTS public.social_feed_sessions (
  token_hash      text PRIMARY KEY,
  wallet_address  text NOT NULL,
  chain_id        integer NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  CONSTRAINT social_feed_sessions_token_hash_length CHECK (length(token_hash) = 64)
);

CREATE INDEX IF NOT EXISTS social_feed_sessions_wallet_idx
  ON public.social_feed_sessions (wallet_address, chain_id, expires_at DESC)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE public.social_post_fires IS 'One Fire (rocket) per wallet per post.';
COMMENT ON TABLE public.social_post_reposts IS 'One Repost per wallet per post.';
COMMENT ON TABLE public.social_feed_sessions IS 'Wallet-signed session for Fire, Repost, and Reply. Token is hashed; raw token never stored.';

COMMIT;
