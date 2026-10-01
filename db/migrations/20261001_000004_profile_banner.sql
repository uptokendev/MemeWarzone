BEGIN;

-- Optional cover photo on public profiles / Command Center (X-style header).
-- Empty banner_url → the app draws a CSS warzone gradient. Founder applies this.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS banner_url text;

COMMENT ON COLUMN public.user_profiles.banner_url IS
  'Optional public cover image URL. Unsigned on PROFILE_UPSERT like bio. Missing column is fail-closed on GET.';

COMMIT;
