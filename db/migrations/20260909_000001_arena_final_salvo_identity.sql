-- Final Salvo immutable chain/match/result identity.
-- Additive only; does not change Tournament, claim, graduation, sponsorship, MWL or Quarterly economics.

BEGIN;

ALTER TABLE public.arena_vote_tiebreaks
  ADD COLUMN IF NOT EXISTS chain_id integer,
  ADD COLUMN IF NOT EXISTS match_id text,
  ADD COLUMN IF NOT EXISTS winner_token_address text;

UPDATE public.arena_vote_tiebreaks tb
   SET chain_id = b.chain_id
  FROM public.arena_battles b
 WHERE tb.battle_id = b.id
   AND tb.chain_id IS NULL;

UPDATE public.arena_vote_tiebreaks
   SET match_id = battle_id
 WHERE match_id IS NULL OR btrim(match_id) = '';

ALTER TABLE public.arena_vote_tiebreaks
  ALTER COLUMN chain_id SET NOT NULL,
  ALTER COLUMN match_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS arena_vote_tiebreaks_match_identity_uidx
  ON public.arena_vote_tiebreaks (chain_id, tournament_id, round_number, match_id);

CREATE OR REPLACE FUNCTION public.enforce_arena_vote_tiebreak_identity_immutable()
RETURNS trigger AS $$
BEGIN
  IF NEW.chain_id IS DISTINCT FROM OLD.chain_id
     OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
     OR NEW.battle_id IS DISTINCT FROM OLD.battle_id
     OR NEW.round_number IS DISTINCT FROM OLD.round_number
     OR NEW.match_id IS DISTINCT FROM OLD.match_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'FINAL_SALVO_IDENTITY_IMMUTABLE';
  END IF;

  IF OLD.state = 'resolved' THEN
    IF NEW.state IS DISTINCT FROM OLD.state
       OR NEW.winner_side IS DISTINCT FROM OLD.winner_side
       OR NEW.winner_token_address IS DISTINCT FROM OLD.winner_token_address
       OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
       OR NEW.shot_history IS DISTINCT FROM OLD.shot_history THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'FINAL_SALVO_RESULT_IMMUTABLE';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_arena_vote_tiebreak_identity_immutable_update
  ON public.arena_vote_tiebreaks;
CREATE TRIGGER enforce_arena_vote_tiebreak_identity_immutable_update
BEFORE UPDATE ON public.arena_vote_tiebreaks
FOR EACH ROW EXECUTE FUNCTION public.enforce_arena_vote_tiebreak_identity_immutable();

COMMIT;
