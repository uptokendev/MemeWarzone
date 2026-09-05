-- Arena tournament battle modes.
-- Founder decision 2026-09-03:
--   1. NORMAL tournament battles reuse canonical Battle V2 and every round lasts exactly 24 hours.
--   2. BOOST is a separate first-class tournament mode, but its scoring/settlement rules are not yet
--      founder-locked. It therefore exists in schema while live battle creation fails closed.
--
-- This migration deliberately enforces the NORMAL duration at the database boundary so an older
-- API caller cannot accidentally create 12-hour tournament rounds.

BEGIN;

ALTER TABLE public.arena_tournaments
  ADD COLUMN IF NOT EXISTS battle_mode text NOT NULL DEFAULT 'normal';

ALTER TABLE public.arena_tournaments
  ADD COLUMN IF NOT EXISTS round_duration_hours integer NOT NULL DEFAULT 24;

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_battle_mode_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_battle_mode_check
  CHECK (battle_mode IN ('normal', 'boost'));

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_round_duration_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_round_duration_check
  CHECK (
    (battle_mode = 'normal' AND round_duration_hours = 24)
    OR (battle_mode = 'boost' AND round_duration_hours > 0)
  );

ALTER TABLE public.arena_battles
  ADD COLUMN IF NOT EXISTS battle_mode text NOT NULL DEFAULT 'normal';

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_battle_mode_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_battle_mode_check
  CHECK (battle_mode IN ('normal', 'boost'));

CREATE OR REPLACE FUNCTION public.enforce_arena_tournament_battle_mode()
RETURNS trigger AS $$
DECLARE
  tournament_mode text;
  tournament_round_hours integer;
BEGIN
  IF NEW.source <> 'tournament' THEN
    RETURN NEW;
  END IF;

  IF NEW.tournament_id IS NULL OR btrim(NEW.tournament_id) = '' THEN
    RAISE EXCEPTION 'Tournament battle requires tournament_id';
  END IF;

  SELECT battle_mode, round_duration_hours
    INTO tournament_mode, tournament_round_hours
    FROM public.arena_tournaments
   WHERE id = NEW.tournament_id;

  IF tournament_mode IS NULL THEN
    RAISE EXCEPTION 'Tournament % not found for Arena battle %', NEW.tournament_id, NEW.id;
  END IF;

  NEW.battle_mode := tournament_mode;

  IF tournament_mode = 'normal' THEN
    IF NEW.started_at IS NULL THEN
      RAISE EXCEPTION 'Normal tournament battle % requires started_at', NEW.id;
    END IF;
    -- Canonical founder rule: every normal tournament round is exactly 24 hours.
    NEW.ends_at := NEW.started_at + interval '24 hours';
    RETURN NEW;
  END IF;

  IF tournament_mode = 'boost' THEN
    -- BOOST exists as an explicit product mode, but no scoring/winner/payout definition has been
    -- founder-locked yet. Refuse to create a live Boost battle rather than silently settling it as
    -- a normal Battle V2 contest.
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BOOST_RULES_NOT_CONFIGURED',
      DETAIL = format('Tournament %s is configured for Boost Battles; scoring and settlement rules must be configured before battle creation.', NEW.tournament_id);
  END IF;

  RAISE EXCEPTION 'Unsupported tournament battle mode %', tournament_mode;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_arena_tournament_battle_mode_insert ON public.arena_battles;
CREATE TRIGGER enforce_arena_tournament_battle_mode_insert
BEFORE INSERT ON public.arena_battles
FOR EACH ROW
WHEN (NEW.source = 'tournament')
EXECUTE FUNCTION public.enforce_arena_tournament_battle_mode();

DROP TRIGGER IF EXISTS enforce_arena_tournament_battle_mode_update ON public.arena_battles;
CREATE TRIGGER enforce_arena_tournament_battle_mode_update
BEFORE UPDATE OF started_at, ends_at, source, tournament_id, battle_mode ON public.arena_battles
FOR EACH ROW
WHEN (NEW.source = 'tournament')
EXECUTE FUNCTION public.enforce_arena_tournament_battle_mode();

CREATE INDEX IF NOT EXISTS arena_tournaments_battle_mode_idx
  ON public.arena_tournaments (battle_mode, status, chain_id, starts_at);

CREATE INDEX IF NOT EXISTS arena_battles_tournament_mode_idx
  ON public.arena_battles (tournament_id, battle_mode, state, ends_at)
  WHERE source = 'tournament';

COMMENT ON COLUMN public.arena_tournaments.battle_mode IS
  'Tournament combat mode: normal uses canonical Battle V2; boost is reserved until Boost scoring/settlement is founder-configured.';
COMMENT ON COLUMN public.arena_tournaments.round_duration_hours IS
  'Round duration. Normal mode is founder-locked to exactly 24 hours.';
COMMENT ON COLUMN public.arena_battles.battle_mode IS
  'Battle scoring mode inherited from the parent tournament for tournament-sourced battles.';

COMMIT;
