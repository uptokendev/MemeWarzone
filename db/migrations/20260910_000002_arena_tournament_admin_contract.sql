-- Tournament Admin backend contract completion.
-- Additive, replay-safe, generation-scoped. Historical Tournament rows keep their
-- persisted meaning; only admin_contract_version = 1 rows require the new contract.

BEGIN;

ALTER TABLE public.arena_tournaments
  ADD COLUMN IF NOT EXISTS tournament_type text,
  ADD COLUMN IF NOT EXISTS environment text,
  ADD COLUMN IF NOT EXISTS solana_cluster text,
  ADD COLUMN IF NOT EXISTS registration_state text,
  ADD COLUMN IF NOT EXISTS registration_opens_at timestamptz,
  ADD COLUMN IF NOT EXISTS registration_closes_at timestamptz,
  ADD COLUMN IF NOT EXISTS start_mode text,
  ADD COLUMN IF NOT EXISTS sponsor_reference text,
  ADD COLUMN IF NOT EXISTS state_version bigint,
  ADD COLUMN IF NOT EXISTS admin_contract_version integer,
  ADD COLUMN IF NOT EXISTS invite_wallets jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.arena_tournaments
   SET state_version = 1
 WHERE state_version IS NULL;

ALTER TABLE public.arena_tournaments
  ALTER COLUMN state_version SET DEFAULT 1,
  ALTER COLUMN state_version SET NOT NULL;

-- Current founder authority: Battle Tournament rounds are 12h or 24h. Vote
-- Tournament regulation is configurable in integer hours >= 1, defaulting to 24h
-- at the API. Existing historical rows are already 24h and remain valid.
ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_round_duration_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_round_duration_check CHECK (
    admin_contract_version IS NULL
    OR (battle_mode = 'normal' AND round_duration_hours IN (12, 24))
    OR (battle_mode = 'vote' AND round_duration_hours >= 1)
  );

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_battle_mode_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_battle_mode_check CHECK (battle_mode IN ('normal', 'boost', 'vote'));

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_admin_contract_version_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_admin_contract_version_check CHECK (
    admin_contract_version IS NULL OR admin_contract_version = 1
  );

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_tournament_type_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_tournament_type_check CHECK (
    tournament_type IS NULL OR tournament_type IN ('battle', 'vote')
  );

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_environment_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_environment_check CHECK (
    environment IS NULL OR environment IN ('staging', 'production')
  );

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_solana_cluster_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_solana_cluster_check CHECK (
    solana_cluster IS NULL OR solana_cluster IN ('devnet', 'mainnet-beta')
  );

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_registration_state_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_registration_state_check CHECK (
    registration_state IS NULL OR registration_state IN ('pending', 'open', 'closed')
  );

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_start_mode_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_start_mode_check CHECK (
    start_mode IS NULL OR start_mode IN ('manual', 'scheduled')
  );

-- Canonical chain/environment identity is required only for the new admin
-- generation. Solana keeps chain_id=101 but persists the cluster explicitly.
ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_admin_chain_environment_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_admin_chain_environment_check CHECK (
    admin_contract_version IS NULL OR (
      (chain_id = 97    AND environment = 'staging'    AND solana_cluster IS NULL)
      OR (chain_id = 56    AND environment = 'production' AND solana_cluster IS NULL)
      OR (chain_id = 46630 AND environment = 'staging'    AND solana_cluster IS NULL)
      OR (chain_id = 4663  AND environment = 'production' AND solana_cluster IS NULL)
      OR (chain_id = 101   AND environment = 'staging'    AND solana_cluster = 'devnet')
      OR (chain_id = 101   AND environment = 'production' AND solana_cluster = 'mainnet-beta')
    )
  );

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_admin_type_mode_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_admin_type_mode_check CHECK (
    admin_contract_version IS NULL
    OR (tournament_type = 'battle' AND battle_mode = 'normal')
    OR (tournament_type = 'vote' AND battle_mode = 'vote')
  );

-- New admin tournaments are exact single-elimination brackets with a minimum of
-- four entrants. There is no application-level maximum; the column's native
-- integer range is the only storage bound.
ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_admin_bracket_size_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_admin_bracket_size_check CHECK (
    admin_contract_version IS NULL
    OR (cap >= 4 AND (cap & (cap - 1)) = 0)
  );

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_admin_windows_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_admin_windows_check CHECK (
    admin_contract_version IS NULL OR (
      tournament_type IS NOT NULL
      AND environment IS NOT NULL
      AND registration_state IS NOT NULL
      AND registration_opens_at IS NOT NULL
      AND registration_closes_at IS NOT NULL
      AND registration_closes_at > registration_opens_at
      AND start_mode IS NOT NULL
      AND starts_at IS NOT NULL
      AND (start_mode <> 'scheduled' OR starts_at >= registration_closes_at)
    )
  );

-- The Tournament battle trigger remains the single duration/identity boundary.
-- Vote regulation can now evolve by persisted round_duration_hours. Final Salvo
-- is a separate phase and is intentionally not modified here.
CREATE OR REPLACE FUNCTION public.enforce_arena_tournament_battle_mode()
RETURNS trigger AS $$
DECLARE
  tournament_mode text;
  tournament_round_hours integer;
  tournament_scoring_version text;
  tournament_generation text;
BEGIN
  IF NEW.source <> 'tournament' THEN
    RETURN NEW;
  END IF;

  IF NEW.tournament_id IS NULL OR btrim(NEW.tournament_id) = '' THEN
    RAISE EXCEPTION 'Tournament battle requires tournament_id';
  END IF;

  SELECT battle_mode, round_duration_hours, contest_scoring_version, competition_generation
    INTO tournament_mode, tournament_round_hours, tournament_scoring_version, tournament_generation
    FROM public.arena_tournaments
   WHERE id = NEW.tournament_id;

  IF tournament_mode IS NULL THEN
    RAISE EXCEPTION 'Tournament % not found for Arena battle %', NEW.tournament_id, NEW.id;
  END IF;

  NEW.battle_mode := tournament_mode;
  NEW.contest_scoring_version := tournament_scoring_version;
  NEW.competition_generation := tournament_generation;

  IF NEW.started_at IS NULL THEN
    RAISE EXCEPTION 'Tournament battle % requires started_at', NEW.id;
  END IF;

  IF tournament_mode = 'normal' AND tournament_round_hours NOT IN (12, 24) THEN
    RAISE EXCEPTION 'Battle Tournament % round duration must be 12 or 24 hours', NEW.tournament_id;
  END IF;
  IF tournament_mode = 'vote' AND (tournament_round_hours IS NULL OR tournament_round_hours < 1) THEN
    RAISE EXCEPTION 'Vote Tournament % round duration must be at least 1 hour', NEW.tournament_id;
  END IF;

  NEW.ends_at := NEW.started_at + make_interval(hours => tournament_round_hours);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Make OPEN/CLOSE authoritative for new admin rows without changing legacy
-- upcoming rows that predate this contract generation.
CREATE OR REPLACE FUNCTION public.enforce_arena_tournament_roster_open()
RETURNS trigger AS $$
DECLARE
  tournament_status text;
  contract_version integer;
  registration_status text;
  opens_at timestamptz;
  closes_at timestamptz;
BEGIN
  SELECT status, admin_contract_version, registration_state, registration_opens_at, registration_closes_at
    INTO tournament_status, contract_version, registration_status, opens_at, closes_at
    FROM public.arena_tournaments
   WHERE id = NEW.tournament_id
   FOR KEY SHARE;

  IF tournament_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TOURNAMENT_NOT_FOUND';
  END IF;

  IF tournament_status <> 'upcoming' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'TOURNAMENT_REGISTRATION_CLOSED';
  END IF;

  IF contract_version = 1 AND (
       registration_status <> 'open'
       OR opens_at IS NULL OR closes_at IS NULL
       OR NOW() < opens_at OR NOW() >= closes_at
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'TOURNAMENT_REGISTRATION_CLOSED',
      DETAIL = format('Tournament %s registration state is %s', NEW.tournament_id, COALESCE(registration_status, 'unset'));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN public.arena_tournaments.admin_contract_version IS
  'NULL preserves historical Tournament generation; 1 enables the authenticated canonical Tournament Admin contract.';
COMMENT ON COLUMN public.arena_tournaments.environment IS
  'Canonical Tournament runtime environment: staging or production.';
COMMENT ON COLUMN public.arena_tournaments.solana_cluster IS
  'Explicit Solana identity for chain_id 101: devnet or mainnet-beta.';
COMMENT ON COLUMN public.arena_tournaments.registration_state IS
  'Admin-controlled registration state for admin_contract_version=1 rows.';
COMMENT ON COLUMN public.arena_tournaments.state_version IS
  'Optimistic concurrency version for authenticated Tournament admin mutations.';


COMMIT;
