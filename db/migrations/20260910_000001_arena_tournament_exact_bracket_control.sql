-- Arena Normal Tournament core-control hardening.
-- New and not-yet-started tournaments: exact elimination brackets, no synthetic byes, no battle before starts_at.
-- Already-started historical tournament rows are grandfathered to preserve generation safety.

BEGIN;

ALTER TABLE public.arena_tournaments
  ADD COLUMN IF NOT EXISTS exact_bracket_required boolean;

-- Preserve already-started historical generations. Existing upcoming rows have not
-- entered combat yet, so they adopt the new exact-bracket authority before start.
UPDATE public.arena_tournaments
   SET exact_bracket_required = CASE WHEN status = 'upcoming' THEN true ELSE false END
 WHERE exact_bracket_required IS NULL;

ALTER TABLE public.arena_tournaments
  ALTER COLUMN exact_bracket_required SET DEFAULT true;
ALTER TABLE public.arena_tournaments
  ALTER COLUMN exact_bracket_required SET NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_arena_tournament_exact_bracket()
RETURNS trigger AS $$
DECLARE
  round_row jsonb;
  match_row jsonb;
  match_count integer;
BEGIN
  IF NEW.exact_bracket_required IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('live', 'finished') THEN
    IF NEW.starts_at IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'TOURNAMENT_START_TIME_REQUIRED';
    END IF;

    IF NEW.starts_at > NOW() THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'TOURNAMENT_START_TIME_NOT_REACHED',
        DETAIL = format('Tournament %s starts at %s', NEW.id, NEW.starts_at);
    END IF;

    IF jsonb_typeof(COALESCE(NEW.bracket, '{}'::jsonb)) <> 'object'
       OR jsonb_typeof(COALESCE(NEW.bracket->'rounds', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(NEW.bracket->'rounds', '[]'::jsonb)) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'TOURNAMENT_EXACT_BRACKET_REQUIRED';
    END IF;

    FOR round_row IN
      SELECT value FROM jsonb_array_elements(NEW.bracket->'rounds')
    LOOP
      IF jsonb_typeof(COALESCE(round_row->'matches', '[]'::jsonb)) <> 'array' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TOURNAMENT_EXACT_BRACKET_REQUIRED';
      END IF;

      match_count := jsonb_array_length(COALESCE(round_row->'matches', '[]'::jsonb));
      IF match_count < 1 OR (match_count & (match_count - 1)) <> 0 THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'TOURNAMENT_EXACT_BRACKET_REQUIRED',
          DETAIL = format('Round has %s matches; match count must be a power of two', match_count);
      END IF;

      FOR match_row IN
        SELECT value FROM jsonb_array_elements(round_row->'matches')
      LOOP
        IF COALESCE((match_row->>'bye')::boolean, false)
           OR NULLIF(btrim(COALESCE(match_row->>'tokenA', '')), '') IS NULL
           OR NULLIF(btrim(COALESCE(match_row->>'tokenB', '')), '') IS NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'TOURNAMENT_BYE_FORBIDDEN';
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_arena_tournament_exact_bracket_write ON public.arena_tournaments;
CREATE TRIGGER enforce_arena_tournament_exact_bracket_write
BEFORE INSERT OR UPDATE OF status, starts_at, bracket, exact_bracket_required
ON public.arena_tournaments
FOR EACH ROW
EXECUTE FUNCTION public.enforce_arena_tournament_exact_bracket();

-- Serialize roster mutation against the same parent-row lock used by Start.
-- If registration wins the lock, Start waits and includes that committed entry.
-- If Start wins, registration waits and then observes status=live and fails closed.
CREATE OR REPLACE FUNCTION public.enforce_arena_tournament_roster_open()
RETURNS trigger AS $$
DECLARE
  tournament_status text;
BEGIN
  SELECT status
    INTO tournament_status
    FROM public.arena_tournaments
   WHERE id = NEW.tournament_id
   FOR KEY SHARE;

  IF tournament_status IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'TOURNAMENT_NOT_FOUND';
  END IF;

  IF tournament_status <> 'upcoming' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'TOURNAMENT_REGISTRATION_CLOSED',
      DETAIL = format('Tournament %s status is %s', NEW.tournament_id, tournament_status);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_arena_tournament_roster_open_insert ON public.arena_tournament_entries;
CREATE TRIGGER enforce_arena_tournament_roster_open_insert
BEFORE INSERT ON public.arena_tournament_entries
FOR EACH ROW
EXECUTE FUNCTION public.enforce_arena_tournament_roster_open();

DROP TRIGGER IF EXISTS enforce_arena_tournament_roster_open_update ON public.arena_tournament_entries;
CREATE TRIGGER enforce_arena_tournament_roster_open_update
BEFORE UPDATE OF buy_in_intent, owner_wallet ON public.arena_tournament_entries
FOR EACH ROW
EXECUTE FUNCTION public.enforce_arena_tournament_roster_open();

CREATE OR REPLACE FUNCTION public.enforce_arena_tournament_battle_start_time()
RETURNS trigger AS $$
DECLARE
  tournament_start timestamptz;
  exact_required boolean;
BEGIN
  IF NEW.source <> 'tournament' THEN
    RETURN NEW;
  END IF;

  SELECT starts_at, exact_bracket_required
    INTO tournament_start, exact_required
    FROM public.arena_tournaments
   WHERE id = NEW.tournament_id
     AND chain_id = NEW.chain_id;

  IF exact_required IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  IF tournament_start IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TOURNAMENT_START_TIME_REQUIRED';
  END IF;

  IF NOW() < tournament_start THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'TOURNAMENT_START_TIME_NOT_REACHED',
      DETAIL = format('Tournament %s starts at %s', NEW.tournament_id, tournament_start);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_arena_tournament_battle_start_time_insert ON public.arena_battles;
CREATE TRIGGER enforce_arena_tournament_battle_start_time_insert
BEFORE INSERT ON public.arena_battles
FOR EACH ROW
WHEN (NEW.source = 'tournament')
EXECUTE FUNCTION public.enforce_arena_tournament_battle_start_time();

COMMENT ON COLUMN public.arena_tournaments.exact_bracket_required IS
  'Generation flag: true for new/not-yet-started tournaments that require exact single-elimination brackets without synthetic byes; false preserves already-started historical generations.';

COMMIT;
