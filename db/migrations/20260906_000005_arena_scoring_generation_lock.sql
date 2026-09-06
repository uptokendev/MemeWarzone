-- Arena Battle scoring foundation: make the per-Battle generation lock explicit and immutable.
-- Additive only. Historical battle_points_v2 rows remain V2; nothing is migrated to V3.

BEGIN;

ALTER TABLE IF EXISTS public.arena_battle_metrics
  ADD COLUMN IF NOT EXISTS scoring_generation text,
  ADD COLUMN IF NOT EXISTS curve_version text;

UPDATE public.arena_battle_metrics
   SET scoring_generation = scoring_version
 WHERE scoring_generation IS NULL;

UPDATE public.arena_battle_metrics
   SET curve_version = CASE
     WHEN scoring_version = 'battle_points_v3' THEN 'boost_hyperbolic_100_v1'
     ELSE NULL
   END
 WHERE curve_version IS NULL;

ALTER TABLE IF EXISTS public.arena_battle_metrics
  ALTER COLUMN scoring_generation SET DEFAULT 'battle_points_v2';

CREATE OR REPLACE FUNCTION public.guard_arena_battle_scoring_lock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.scoring_version IS DISTINCT FROM NEW.scoring_version
     OR OLD.scoring_generation IS DISTINCT FROM NEW.scoring_generation
     OR OLD.curve_version IS DISTINCT FROM NEW.curve_version THEN
    RAISE EXCEPTION 'arena battle scoring lock is immutable for battle %, side %', OLD.battle_id, OLD.side;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_arena_battle_scoring_lock ON public.arena_battle_metrics;
CREATE TRIGGER guard_arena_battle_scoring_lock
BEFORE UPDATE OF scoring_version, scoring_generation, curve_version
ON public.arena_battle_metrics
FOR EACH ROW EXECUTE FUNCTION public.guard_arena_battle_scoring_lock();

-- Existing V3 projection storage already owns the frozen Boost-curve evidence.
-- This constraint prevents an invalid curve from being attached to a V3 metrics lock.
ALTER TABLE IF EXISTS public.arena_battle_metrics
  DROP CONSTRAINT IF EXISTS arena_battle_metrics_curve_lock_check;
ALTER TABLE IF EXISTS public.arena_battle_metrics
  ADD CONSTRAINT arena_battle_metrics_curve_lock_check CHECK (
    (scoring_generation = 'battle_points_v3' AND curve_version = 'boost_hyperbolic_100_v1')
    OR (scoring_generation <> 'battle_points_v3' AND curve_version IS NULL)
  );

COMMIT;
