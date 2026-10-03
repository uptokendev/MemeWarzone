BEGIN;

-- Edit profile tab (CO-19, founder 2026-10-03): banner position and profile links. banner_url
-- already exists. Position is vertical focus in percent (0 top, 50 centre, 100 bottom), the same
-- as the coin banner. Links are https URLs (website) or handles/URLs (X, Telegram), checked by the API.
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS banner_position_y smallint
    CHECK (banner_position_y IS NULL OR banner_position_y BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS website_url text
    CHECK (website_url IS NULL OR char_length(website_url) <= 200),
  ADD COLUMN IF NOT EXISTS x_url text
    CHECK (x_url IS NULL OR char_length(x_url) <= 200),
  ADD COLUMN IF NOT EXISTS telegram_url text
    CHECK (telegram_url IS NULL OR char_length(telegram_url) <= 200);

COMMIT;
