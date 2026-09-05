-- Challenge counter-offers: current proposed stake and whose turn it is to respond.
BEGIN;

ALTER TABLE public.arena_battles
  ADD COLUMN IF NOT EXISTS offered_stake_native numeric,
  ADD COLUMN IF NOT EXISTS offer_from_token text,
  ADD COLUMN IF NOT EXISTS offer_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_offer_count_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_offer_count_check CHECK (offer_count >= 0);

COMMIT;
