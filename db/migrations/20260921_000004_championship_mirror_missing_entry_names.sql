-- mirror_mwl_point_to_quarterly_championship: tolerate a token without an
-- arena_league_entries row yet.
--
-- Found 2026-09-21 by the Vote Battle integration run on the live schema: the
-- first battle a token ever finishes writes its arena_league_point_events row
-- before recordFinishedBattle() upserts the league entry (that is the order
-- in frontend/api/lib/arenaLeagueScore.js). SELECT ... INTO with no row sets
-- entry_name / entry_symbol to NULL, so the championship entry insert fails
-- on token_name NOT NULL and the whole settlement transaction rolls back.
-- No finished battle has ever gone through this path on the live database
-- (0 finished battles, 0 battle point events), so nothing is corrected here;
-- the function simply falls back to '' like it already intends
-- ("CASE WHEN excluded.token_name <> ''"), and the later league-entry upsert
-- fills the name in on the next mirrored event.
--
-- Body identical to 20260907_000002 apart from the two COALESCE lines.

BEGIN;

CREATE OR REPLACE FUNCTION public.mirror_mwl_point_to_quarterly_championship()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  epoch_row public.arena_championship_epochs%ROWTYPE;
  source_inserted integer := 0;
  entry_name text := '';
  entry_symbol text := '';
  recomputed_base numeric(20,4) := 0;
BEGIN
  SELECT e.*
    INTO epoch_row
    FROM public.arena_league_seasons s
    JOIN public.arena_championship_epochs e
      ON e.id = s.championship_epoch_id
   WHERE s.id = NEW.season_id
   LIMIT 1;

  IF NOT FOUND OR epoch_row.state <> 'open' THEN
    RETURN NEW;
  END IF;

  -- A point event can belong to exactly one canonical quarter and must be
  -- timestamped inside that quarter. Late writes to an ended/other quarter do
  -- not contaminate the active Championship.
  IF NEW.created_at < epoch_row.opens_at OR NEW.created_at >= epoch_row.closes_at THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.arena_championship_point_events
    (epoch_id,token_address,source_kind,source_id,source_season_id,points,metadata)
  VALUES (
    epoch_row.id,
    NEW.token_address,
    'mwl_base',
    NEW.id::text,
    NEW.season_id,
    NEW.points,
    jsonb_build_object(
      'leagueEventId', NEW.id::text,
      'leagueEventKind', NEW.kind,
      'battleId', NEW.battle_id,
      'pairKey', NEW.pair_key,
      'utcDay', NEW.utc_day
    )
  )
  ON CONFLICT (epoch_id,source_kind,source_id,token_address) DO NOTHING;

  GET DIAGNOSTICS source_inserted = ROW_COUNT;
  IF source_inserted = 0 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(le.token_name,''), COALESCE(le.symbol,'')
    INTO entry_name, entry_symbol
    FROM public.arena_league_entries le
   WHERE le.season_id = NEW.season_id
     AND le.token_address = NEW.token_address
   LIMIT 1;

  -- No league entry yet (first event for this token): SELECT INTO left the
  -- variables NULL, and arena_championship_entries.token_name is NOT NULL.
  entry_name := COALESCE(entry_name, '');
  entry_symbol := COALESCE(entry_symbol, '');

  SELECT COALESCE(sum(pe.points),0)
    INTO recomputed_base
    FROM public.arena_championship_point_events pe
   WHERE pe.epoch_id = epoch_row.id
     AND pe.token_address = NEW.token_address
     AND pe.source_kind = 'mwl_base';

  INSERT INTO public.arena_championship_entries
    (epoch_id,token_address,token_name,symbol,base_points)
  VALUES (epoch_row.id,NEW.token_address,entry_name,entry_symbol,recomputed_base)
  ON CONFLICT (epoch_id,token_address) DO UPDATE
    SET token_name = CASE WHEN excluded.token_name <> '' THEN excluded.token_name ELSE public.arena_championship_entries.token_name END,
        symbol = CASE WHEN excluded.symbol <> '' THEN excluded.symbol ELSE public.arena_championship_entries.symbol END,
        base_points = excluded.base_points,
        updated_at = now();

  RETURN NEW;
END;
$$;

COMMIT;
