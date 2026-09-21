-- arena_league_entries: token_address is the identity the code writes.
--
-- Found 2026-09-21 by the Vote Battle integration run on the live schema.
-- Both Supabase projects carry the table in the shape of
-- database/arena_league_import.sql (token_id NOT NULL, UNIQUE (season_id,
-- token_id), token_address nullable), not the shape of
-- 20260826_000001_arena_identity_schema.sql (token_address NOT NULL, UNIQUE
-- (season_id, token_address)). frontend/api/lib/arenaLeagueScore.js
-- bumpEntry() inserts token_address only and upserts
-- ON CONFLICT (season_id, token_address), so every league write (battle
-- finish, check-in, dispatch) fails with "no unique or exclusion constraint
-- matching the ON CONFLICT specification" and rolls the settlement back.
-- Nothing has gone through this path on the live database yet (0 battle
-- point events), and every existing row already has token_address =
-- token_id (the mock season-01 rows).
--
-- Additive: token_address becomes NOT NULL (backfilled from token_id), a
-- unique index on (season_id, token_address) serves the upsert, and token_id
-- stays for the older readers, filled from token_address by a trigger so the
-- legacy unique index keeps agreeing with the new one.

BEGIN;

ALTER TABLE public.arena_league_entries
  ADD COLUMN IF NOT EXISTS token_address text;

UPDATE public.arena_league_entries
   SET token_address = token_id
 WHERE token_address IS NULL OR btrim(token_address) = '';

ALTER TABLE public.arena_league_entries
  ALTER COLUMN token_address SET NOT NULL;

ALTER TABLE public.arena_league_entries
  ALTER COLUMN token_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.arena_league_entries_sync_token_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.token_address IS NULL OR btrim(NEW.token_address) = '' THEN
    NEW.token_address := NEW.token_id;
  END IF;
  IF NEW.token_id IS NULL OR btrim(NEW.token_id) = '' THEN
    NEW.token_id := NEW.token_address;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS arena_league_entries_sync_token_identity ON public.arena_league_entries;
CREATE TRIGGER arena_league_entries_sync_token_identity
BEFORE INSERT OR UPDATE ON public.arena_league_entries
FOR EACH ROW EXECUTE FUNCTION public.arena_league_entries_sync_token_identity();

CREATE UNIQUE INDEX IF NOT EXISTS arena_league_entries_season_token_address_uidx
  ON public.arena_league_entries (season_id, token_address);

COMMIT;
