BEGIN;

-- Wallet-identity posts for /feed, Command Center, and public profiles.
-- Solana authors keep base58 case (no lowercase CHECK). EVM authors are stored lowercase by the API.

CREATE TABLE IF NOT EXISTS public.social_posts (
  id                  bigserial PRIMARY KEY,
  author_address      text NOT NULL,
  body                text NOT NULL,
  media_url           text,
  mentioned_chain_id  integer,
  mentioned_campaign  text,
  mentioned_token     text,
  status              smallint NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT social_posts_body_not_empty CHECK (length(btrim(body)) > 0),
  CONSTRAINT social_posts_body_max CHECK (char_length(body) <= 280),
  CONSTRAINT social_posts_status_known CHECK (status IN (0, 1, 2))
);

CREATE INDEX IF NOT EXISTS social_posts_created_at_idx
  ON public.social_posts (created_at DESC);

CREATE INDEX IF NOT EXISTS social_posts_author_created_idx
  ON public.social_posts (author_address, created_at DESC);

CREATE INDEX IF NOT EXISTS social_posts_status_created_idx
  ON public.social_posts (status, created_at DESC);

COMMENT ON TABLE public.social_posts IS 'Free-form wallet posts for the MemeWarzone social feed. status: 0 active, 1 hidden, 2 deleted.';

-- Second layer next to the default privileges: no policies, so the Supabase REST roles (anon,
-- authenticated) read and write nothing. The API connects as the table owner and is not affected.
ALTER TABLE public.social_posts ENABLE ROW LEVEL SECURITY;

COMMIT;
