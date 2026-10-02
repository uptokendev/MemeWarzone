BEGIN;

-- UI redesign phase 2: quote posts. A quote is a normal top-level post that points at another
-- top-level post. Nullable; existing rows and readers are unaffected. If the quoted post is deleted
-- (status 2 is a soft delete, so this only fires on a hard delete) the quote keeps its own text.
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS quote_of_id bigint REFERENCES public.social_posts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS social_posts_quote_of_idx
  ON public.social_posts (quote_of_id)
  WHERE quote_of_id IS NOT NULL;

COMMIT;
