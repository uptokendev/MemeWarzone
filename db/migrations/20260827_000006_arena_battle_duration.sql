-- Agreed fight length: 24 hours, 3 days, or 7 days. Locked when both sides accept the offer.
BEGIN;

ALTER TABLE public.arena_battles
  ADD COLUMN IF NOT EXISTS duration_hours integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS offered_duration_hours integer;

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_duration_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_duration_check CHECK (duration_hours IN (24, 72, 168));
ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_offered_duration_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_offered_duration_check CHECK (
    offered_duration_hours IS NULL OR offered_duration_hours IN (24, 72, 168)
  );

COMMIT;
