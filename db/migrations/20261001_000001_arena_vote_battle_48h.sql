-- Vote Battle clocks (founder, 2026-10-01): 6, 12, 24 or 48 hours. New challenges
-- offer only those four. 1 hour stays allowed in the check so battles created
-- before this change keep passing; the API no longer creates them.
--
-- Additive only: both checks are re-stated with 48 added. Metrics battles keep
-- 24 / 72 / 168.
BEGIN;

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_duration_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_duration_check CHECK (
    (COALESCE(battle_mode, 'normal') = 'vote' AND duration_hours IN (1, 6, 12, 24, 48))
    OR (COALESCE(battle_mode, 'normal') <> 'vote' AND duration_hours IN (24, 72, 168))
  );

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_offered_duration_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_offered_duration_check CHECK (
    offered_duration_hours IS NULL
    OR (COALESCE(battle_mode, 'normal') = 'vote' AND offered_duration_hours IN (1, 6, 12, 24, 48))
    OR (COALESCE(battle_mode, 'normal') <> 'vote' AND offered_duration_hours IN (24, 72, 168))
  );

COMMIT;
