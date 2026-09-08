-- Continuous Quarterly Championship base-point feed.
-- Mirrors the existing authoritative MWL point ledger exactly once into the
-- active quarter. No scoring constants or bonus economics are introduced here.
BEGIN;

ALTER TABLE public.arena_championship_point_events
  DROP CONSTRAINT IF EXISTS arena_championship_point_events_kind_check;
ALTER TABLE public.arena_championship_point_events
  ADD CONSTRAINT arena_championship_point_events_kind_check
  CHECK (source_kind IN ('mwl_base', 'mwl_bonus'));

ALTER TABLE public.arena_championship_point_events
  DROP CONSTRAINT IF EXISTS arena_championship_point_events_points_check;
ALTER TABLE public.arena_championship_point_events
  ADD CONSTRAINT arena_championship_point_events_points_check
  CHECK (
    (source_kind = 'mwl_base' AND points >= 0)
    OR (source_kind = 'mwl_bonus' AND points > 0)
  );

-- Preserve any already-active legacy quarter-keyed MWL by giving it the same
-- canonical Championship epoch identity used by new monthly MWLs. Historical
-- closed seasons are not rewritten.
INSERT INTO public.arena_championship_epochs
  (id,event_type,chain_id,year,quarter,state,opens_at,closes_at)
SELECT DISTINCT
  'quarterly-championship-' || s.year::text || '-q' || s.quarter::text || '-c' || s.chain_id::text,
  'quarterly_championship',
  s.chain_id,
  s.year,
  s.quarter,
  'open',
  make_timestamptz(s.year, ((s.quarter - 1) * 3) + 1, 1, 0, 0, 0, 'UTC'),
  make_timestamptz(s.year, ((s.quarter - 1) * 3) + 1, 1, 0, 0, 0, 'UTC') + interval '3 months'
FROM public.arena_league_seasons s
WHERE s.active = true
  AND s.year IS NOT NULL
  AND s.quarter BETWEEN 1 AND 4
  AND s.chain_id IS NOT NULL
ON CONFLICT (chain_id,year,quarter) DO NOTHING;

UPDATE public.arena_league_seasons s
   SET championship_epoch_id = e.id,
       updated_at = now()
  FROM public.arena_championship_epochs e
 WHERE s.active = true
   AND s.championship_epoch_id IS NULL
   AND e.chain_id = s.chain_id
   AND e.year = s.year
   AND e.quarter = s.quarter;

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

REVOKE ALL ON FUNCTION public.mirror_mwl_point_to_quarterly_championship() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mirror_mwl_point_to_quarterly_championship() TO service_role;

DROP TRIGGER IF EXISTS mirror_mwl_point_to_quarterly_championship ON public.arena_league_point_events;
CREATE TRIGGER mirror_mwl_point_to_quarterly_championship
AFTER INSERT ON public.arena_league_point_events
FOR EACH ROW
EXECUTE FUNCTION public.mirror_mwl_point_to_quarterly_championship();

-- Backfill already-recorded point events from any currently active MWL so the
-- Championship does not start at zero partway through an in-progress quarter.
INSERT INTO public.arena_championship_point_events
  (epoch_id,token_address,source_kind,source_id,source_season_id,points,metadata)
SELECT
  e.id,
  lp.token_address,
  'mwl_base',
  lp.id::text,
  lp.season_id,
  lp.points,
  jsonb_build_object(
    'leagueEventId', lp.id::text,
    'leagueEventKind', lp.kind,
    'battleId', lp.battle_id,
    'pairKey', lp.pair_key,
    'utcDay', lp.utc_day,
    'backfilled', true
  )
FROM public.arena_league_point_events lp
JOIN public.arena_league_seasons s ON s.id = lp.season_id
JOIN public.arena_championship_epochs e ON e.id = s.championship_epoch_id
WHERE s.active = true
  AND e.state = 'open'
  AND lp.created_at >= e.opens_at
  AND lp.created_at < e.closes_at
ON CONFLICT (epoch_id,source_kind,source_id,token_address) DO NOTHING;

INSERT INTO public.arena_championship_entries
  (epoch_id,token_address,token_name,symbol,base_points)
SELECT
  pe.epoch_id,
  pe.token_address,
  COALESCE(max(le.token_name),''),
  COALESCE(max(le.symbol),''),
  sum(pe.points)
FROM public.arena_championship_point_events pe
LEFT JOIN public.arena_league_entries le
  ON le.season_id = pe.source_season_id
 AND le.token_address = pe.token_address
WHERE pe.source_kind = 'mwl_base'
GROUP BY pe.epoch_id,pe.token_address
ON CONFLICT (epoch_id,token_address) DO UPDATE
  SET token_name = CASE WHEN excluded.token_name <> '' THEN excluded.token_name ELSE public.arena_championship_entries.token_name END,
      symbol = CASE WHEN excluded.symbol <> '' THEN excluded.symbol ELSE public.arena_championship_entries.symbol END,
      base_points = excluded.base_points,
      updated_at = now();

COMMIT;
