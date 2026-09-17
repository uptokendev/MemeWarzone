-- One active MWL season per chain, not one globally.
-- The original unique index on (active) blocked 46630/101 while 56 was live.

DROP INDEX IF EXISTS public.arena_league_one_active_season_idx;
CREATE UNIQUE INDEX arena_league_one_active_season_idx
  ON public.arena_league_seasons (chain_id)
  WHERE active = true;
