-- Matched = both owners known, waiting for on-chain war-pool stakes. Live only after both have paid.
-- Remap legacy queue states from database/arena_battles_import.sql before the CHECK,
-- otherwise ADD CONSTRAINT fails with 23514 on live rows.

BEGIN;

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_state_check;

UPDATE public.arena_battles
   SET state = CASE
         WHEN state IN ('draft', 'open_for_battle') THEN 'waiting'
         WHEN state = 'pending' THEN 'challenged'
         WHEN state = 'accepted' THEN 'matched'
         WHEN state IN ('completed', 'settled') THEN 'finished'
         WHEN state = 'cancelled' THEN 'expired'
         ELSE state
       END,
       updated_at = NOW()
 WHERE state NOT IN ('waiting', 'challenged', 'matched', 'live', 'finished', 'expired');

UPDATE public.arena_battles
   SET state = 'expired',
       updated_at = NOW()
 WHERE state NOT IN ('waiting', 'challenged', 'matched', 'live', 'finished', 'expired');

ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_state_check CHECK (
    state IN ('waiting', 'challenged', 'matched', 'live', 'finished', 'expired')
  );

COMMIT;
