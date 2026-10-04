BEGIN;

-- Up to 4 images per post and per creator update (founder 2026-10-04). media_url keeps the first image,
-- so every reader that shows one image is unchanged; media_urls holds all of them in order.
ALTER TABLE public.social_posts ADD COLUMN IF NOT EXISTS media_urls text[];
ALTER TABLE public.coin_posts ADD COLUMN IF NOT EXISTS media_urls text[];

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_posts_media_urls_max') THEN
    ALTER TABLE public.social_posts ADD CONSTRAINT social_posts_media_urls_max
      CHECK (media_urls IS NULL OR cardinality(media_urls) BETWEEN 1 AND 4);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coin_posts_media_urls_max') THEN
    ALTER TABLE public.coin_posts ADD CONSTRAINT coin_posts_media_urls_max
      CHECK (media_urls IS NULL OR cardinality(media_urls) BETWEEN 1 AND 4);
  END IF;
END $$;

COMMIT;
