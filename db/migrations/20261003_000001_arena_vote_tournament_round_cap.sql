-- Vote Tournament round length: whole hours from 1 to 48.
-- 20260910_000002 allowed vote rounds of >= 1 hour with no upper bound. The
-- founder range is 1..48h; the API and the vote runtime enforce the same range.
-- Battle Tournament rounds stay 12 or 24 hours. Rows outside the admin contract
-- (admin_contract_version IS NULL) keep their historical meaning, as before.
--
-- Replay-safe. Fails with a clear message, and changes nothing, if any admin
-- contract vote tournament already sits outside 1..48h.

BEGIN;

DO $$
DECLARE
  offending integer;
BEGIN
  SELECT count(*)
    INTO offending
    FROM public.arena_tournaments
   WHERE admin_contract_version IS NOT NULL
     AND battle_mode = 'vote'
     AND (round_duration_hours IS NULL OR round_duration_hours < 1 OR round_duration_hours > 48);
  IF offending > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'VOTE_TOURNAMENT_ROUND_CAP_BLOCKED',
      DETAIL = format('%s vote tournament row(s) have round_duration_hours outside 1..48; fix them before applying this migration', offending);
  END IF;
END $$;

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_round_duration_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_round_duration_check CHECK (
    admin_contract_version IS NULL
    OR (battle_mode = 'normal' AND round_duration_hours IN (12, 24))
    OR (battle_mode = 'vote' AND round_duration_hours BETWEEN 1 AND 48)
  );

COMMENT ON CONSTRAINT arena_tournaments_round_duration_check ON public.arena_tournaments IS
  'Admin-contract rounds: Battle 12 or 24 hours, Vote 1 to 48 whole hours.';

COMMIT;
