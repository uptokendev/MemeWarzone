-- Runtime activation for Normal Battle V3 scoring.
-- New Normal Battles use V3. Existing Battle rows and existing metric locks are not rewritten.

BEGIN;

CREATE OR REPLACE FUNCTION public.initialize_arena_normal_battle_scoring_defaults()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF COALESCE(NEW.battle_mode, 'normal') = 'normal'
     AND COALESCE(NEW.source, 'queue') <> 'tournament'
     AND NEW.contest_scoring_version IS NULL THEN
    NEW.contest_scoring_version := 'battle_points_v3';
    NEW.competition_generation := 'arena_competition_v2';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS initialize_arena_normal_battle_scoring_defaults ON public.arena_battles;
CREATE TRIGGER initialize_arena_normal_battle_scoring_defaults
BEFORE INSERT ON public.arena_battles
FOR EACH ROW EXECUTE FUNCTION public.initialize_arena_normal_battle_scoring_defaults();

-- PR #205 made the metric row the immutable scoring-generation authority.
-- At live-baseline insert, resolve that authority from the Battle's already-frozen
-- contest generation instead of a process-global feature flag or market snapshot.
CREATE OR REPLACE FUNCTION public.initialize_arena_battle_scoring_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  locked_version text;
BEGIN
  SELECT contest_scoring_version
    INTO locked_version
    FROM public.arena_battles
   WHERE id = NEW.battle_id;

  IF locked_version IS NULL OR locked_version = '' THEN
    locked_version := NEW.scoring_version;
  END IF;

  NEW.scoring_version := locked_version;
  NEW.scoring_generation := locked_version;
  NEW.curve_version := CASE
    WHEN locked_version = 'battle_points_v3' THEN 'boost_hyperbolic_100_v1'
    ELSE NULL
  END;
  RETURN NEW;
END;
$$;

-- Historical rows are deliberately untouched. The PR #205 update guard keeps
-- every inserted lock immutable after the live baseline exists.

COMMIT;
