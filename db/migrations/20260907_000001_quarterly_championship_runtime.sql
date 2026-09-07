-- Quarterly Championship runtime reconciliation.
-- New Championship epochs are continuous standings, not knockout tournaments.
-- Historical quarter_finals columns/tournaments remain untouched for compatibility.
BEGIN;

ALTER TABLE public.arena_league_seasons
  ADD COLUMN IF NOT EXISTS month integer,
  ADD COLUMN IF NOT EXISTS mwl_epoch_key text,
  ADD COLUMN IF NOT EXISTS finalized_at timestamptz,
  ADD COLUMN IF NOT EXISTS championship_epoch_id text;

ALTER TABLE public.arena_league_seasons
  DROP CONSTRAINT IF EXISTS arena_league_seasons_month_check;
ALTER TABLE public.arena_league_seasons
  ADD CONSTRAINT arena_league_seasons_month_check CHECK (month IS NULL OR month BETWEEN 1 AND 12);

CREATE UNIQUE INDEX IF NOT EXISTS arena_league_monthly_epoch_uidx
  ON public.arena_league_seasons (chain_id, year, month)
  WHERE month IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.arena_championship_epochs (
  id text PRIMARY KEY,
  event_type text NOT NULL DEFAULT 'quarterly_championship',
  chain_id integer NOT NULL,
  year integer NOT NULL,
  quarter integer NOT NULL,
  state text NOT NULL DEFAULT 'open',
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_championship_epochs_event_type_check CHECK (event_type = 'quarterly_championship'),
  CONSTRAINT arena_championship_epochs_quarter_check CHECK (quarter BETWEEN 1 AND 4),
  CONSTRAINT arena_championship_epochs_state_check CHECK (state IN ('open', 'closed')),
  CONSTRAINT arena_championship_epochs_window_check CHECK (closes_at > opens_at),
  CONSTRAINT arena_championship_epochs_identity_unique UNIQUE (chain_id, year, quarter)
);

DROP TRIGGER IF EXISTS set_arena_championship_epochs_updated_at ON public.arena_championship_epochs;
CREATE TRIGGER set_arena_championship_epochs_updated_at
BEFORE UPDATE ON public.arena_championship_epochs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.arena_championship_bonus_policies (
  version text PRIMARY KEY,
  chain_id integer,
  status text NOT NULL DEFAULT 'draft',
  active boolean NOT NULL DEFAULT false,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_championship_bonus_policies_status_check CHECK (status IN ('draft', 'approved', 'retired')),
  CONSTRAINT arena_championship_bonus_policies_activation_check CHECK (active = false OR (status = 'approved' AND approved_at IS NOT NULL))
);

DROP TRIGGER IF EXISTS set_arena_championship_bonus_policies_updated_at ON public.arena_championship_bonus_policies;
CREATE TRIGGER set_arena_championship_bonus_policies_updated_at
BEFORE UPDATE ON public.arena_championship_bonus_policies
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS arena_championship_bonus_one_active_scope_uidx
  ON public.arena_championship_bonus_policies ((COALESCE(chain_id, 0)))
  WHERE active = true;

CREATE TABLE IF NOT EXISTS public.arena_championship_bonus_rules (
  policy_version text NOT NULL REFERENCES public.arena_championship_bonus_policies(version) ON DELETE RESTRICT,
  placement integer NOT NULL,
  bonus_points numeric(20,4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (policy_version, placement),
  CONSTRAINT arena_championship_bonus_rules_placement_check CHECK (placement >= 1),
  CONSTRAINT arena_championship_bonus_rules_points_check CHECK (bonus_points > 0)
);

CREATE TABLE IF NOT EXISTS public.arena_championship_mwl_results (
  season_id text NOT NULL REFERENCES public.arena_league_seasons(id) ON DELETE RESTRICT,
  token_address text NOT NULL,
  token_name text NOT NULL DEFAULT '',
  symbol text NOT NULL DEFAULT '',
  final_rank integer NOT NULL,
  mwl_points numeric(20,4) NOT NULL DEFAULT 0,
  wins integer NOT NULL DEFAULT 0,
  losses integer NOT NULL DEFAULT 0,
  finished_fights integer NOT NULL DEFAULT 0,
  captured_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (season_id, token_address),
  CONSTRAINT arena_championship_mwl_results_rank_unique UNIQUE (season_id, final_rank),
  CONSTRAINT arena_championship_mwl_results_rank_check CHECK (final_rank >= 1),
  CONSTRAINT arena_championship_mwl_results_points_check CHECK (mwl_points >= 0)
);

CREATE TABLE IF NOT EXISTS public.arena_championship_entries (
  epoch_id text NOT NULL REFERENCES public.arena_championship_epochs(id) ON DELETE RESTRICT,
  token_address text NOT NULL,
  token_name text NOT NULL DEFAULT '',
  symbol text NOT NULL DEFAULT '',
  base_points numeric(20,4) NOT NULL DEFAULT 0,
  mwl_bonus_points numeric(20,4) NOT NULL DEFAULT 0,
  total_points numeric(20,4) GENERATED ALWAYS AS (base_points + mwl_bonus_points) STORED,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (epoch_id, token_address),
  CONSTRAINT arena_championship_entries_base_check CHECK (base_points >= 0),
  CONSTRAINT arena_championship_entries_mwl_bonus_check CHECK (mwl_bonus_points >= 0)
);

DROP TRIGGER IF EXISTS set_arena_championship_entries_updated_at ON public.arena_championship_entries;
CREATE TRIGGER set_arena_championship_entries_updated_at
BEFORE UPDATE ON public.arena_championship_entries
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.arena_championship_point_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  epoch_id text NOT NULL REFERENCES public.arena_championship_epochs(id) ON DELETE RESTRICT,
  token_address text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_season_id text REFERENCES public.arena_league_seasons(id) ON DELETE RESTRICT,
  points numeric(20,4) NOT NULL,
  policy_version text REFERENCES public.arena_championship_bonus_policies(version) ON DELETE RESTRICT,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_championship_point_events_kind_check CHECK (source_kind = 'mwl_bonus'),
  CONSTRAINT arena_championship_point_events_points_check CHECK (points > 0),
  CONSTRAINT arena_championship_point_events_source_unique UNIQUE (epoch_id, source_kind, source_id, token_address)
);

CREATE INDEX IF NOT EXISTS arena_championship_point_events_epoch_idx
  ON public.arena_championship_point_events (epoch_id, created_at ASC);

CREATE TABLE IF NOT EXISTS public.arena_championship_mwl_transfers (
  season_id text PRIMARY KEY REFERENCES public.arena_league_seasons(id) ON DELETE RESTRICT,
  epoch_id text NOT NULL REFERENCES public.arena_championship_epochs(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending_policy',
  policy_version text REFERENCES public.arena_championship_bonus_policies(version) ON DELETE RESTRICT,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_championship_mwl_transfers_status_check CHECK (status IN ('pending_policy', 'applied')),
  CONSTRAINT arena_championship_mwl_transfers_applied_check CHECK (
    (status = 'pending_policy' AND applied_at IS NULL)
    OR (status = 'applied' AND applied_at IS NOT NULL AND policy_version IS NOT NULL)
  )
);

DROP TRIGGER IF EXISTS set_arena_championship_mwl_transfers_updated_at ON public.arena_championship_mwl_transfers;
CREATE TRIGGER set_arena_championship_mwl_transfers_updated_at
BEFORE UPDATE ON public.arena_championship_mwl_transfers
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.arena_championship_final_standings (
  epoch_id text NOT NULL REFERENCES public.arena_championship_epochs(id) ON DELETE RESTRICT,
  token_address text NOT NULL,
  token_name text NOT NULL DEFAULT '',
  symbol text NOT NULL DEFAULT '',
  final_rank integer NOT NULL,
  base_points numeric(20,4) NOT NULL DEFAULT 0,
  mwl_bonus_points numeric(20,4) NOT NULL DEFAULT 0,
  total_points numeric(20,4) NOT NULL DEFAULT 0,
  finalized_at timestamptz NOT NULL,
  PRIMARY KEY (epoch_id, token_address),
  CONSTRAINT arena_championship_final_rank_unique UNIQUE (epoch_id, final_rank),
  CONSTRAINT arena_championship_final_rank_check CHECK (final_rank >= 1),
  CONSTRAINT arena_championship_final_points_check CHECK (base_points >= 0 AND mwl_bonus_points >= 0 AND total_points >= 0)
);

DO $$ BEGIN
  ALTER TABLE public.arena_league_seasons
    ADD CONSTRAINT arena_league_seasons_championship_epoch_fk
    FOREIGN KEY (championship_epoch_id) REFERENCES public.arena_championship_epochs(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_championship_epochs FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_championship_entries FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_championship_final_standings FROM anon, authenticated;
REVOKE ALL ON TABLE public.arena_championship_bonus_policies FROM anon, authenticated;
REVOKE ALL ON TABLE public.arena_championship_bonus_rules FROM anon, authenticated;
REVOKE ALL ON TABLE public.arena_championship_mwl_results FROM anon, authenticated;
REVOKE ALL ON TABLE public.arena_championship_point_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.arena_championship_mwl_transfers FROM anon, authenticated;

GRANT SELECT ON TABLE public.arena_championship_epochs TO anon, authenticated;
GRANT SELECT ON TABLE public.arena_championship_entries TO anon, authenticated;
GRANT SELECT ON TABLE public.arena_championship_final_standings TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_championship_epochs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_championship_bonus_policies TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_championship_bonus_rules TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_championship_mwl_results TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_championship_entries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_championship_point_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_championship_mwl_transfers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_championship_final_standings TO service_role;

ALTER TABLE public.arena_championship_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_championship_bonus_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_championship_bonus_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_championship_mwl_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_championship_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_championship_point_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_championship_mwl_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_championship_final_standings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS arena_championship_epochs_public_read ON public.arena_championship_epochs;
CREATE POLICY arena_championship_epochs_public_read ON public.arena_championship_epochs FOR SELECT USING (true);
DROP POLICY IF EXISTS arena_championship_entries_public_read ON public.arena_championship_entries;
CREATE POLICY arena_championship_entries_public_read ON public.arena_championship_entries FOR SELECT USING (true);
DROP POLICY IF EXISTS arena_championship_final_standings_public_read ON public.arena_championship_final_standings;
CREATE POLICY arena_championship_final_standings_public_read ON public.arena_championship_final_standings FOR SELECT USING (true);

COMMIT;
