BEGIN;

-- Coin page banner: the owner drags the image up or down (founder, 2026-10-02). Vertical focus in
-- percent (0 = top, 50 = centre, 100 = bottom), used as CSS object-position. Null = centre.
ALTER TABLE public.token_story_profiles
  ADD COLUMN IF NOT EXISTS banner_position_y smallint
  CHECK (banner_position_y IS NULL OR banner_position_y BETWEEN 0 AND 100);

COMMIT;
