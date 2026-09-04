-- Founder-locked Arena vote, boost, V3, V2 pool, post-grad ledger, and sponsorship foundations.
-- Additive only. No production payment execution or settlement activation.

BEGIN;

UPDATE public.arena_tournaments
   SET battle_mode = 'vote'
 WHERE battle_mode = 'boost';

UPDATE public.arena_battles
   SET battle_mode = 'vote'
 WHERE battle_mode = 'boost';

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_battle_mode_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_battle_mode_check
  CHECK (battle_mode IN ('normal', 'vote'));

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_round_duration_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_round_duration_check
  CHECK (round_duration_hours = 24);

ALTER TABLE public.arena_tournaments
  ADD COLUMN IF NOT EXISTS contest_scoring_version text,
  ADD COLUMN IF NOT EXISTS competition_generation text NOT NULL DEFAULT 'arena_competition_v1';

UPDATE public.arena_tournaments
   SET contest_scoring_version = CASE
     WHEN battle_mode = 'vote' THEN 'vote_tournament_v1'
     ELSE 'battle_points_v3'
   END
 WHERE contest_scoring_version IS NULL;

ALTER TABLE public.arena_tournaments
  ALTER COLUMN contest_scoring_version SET NOT NULL;

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_contest_scoring_version_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_contest_scoring_version_check
  CHECK (contest_scoring_version IN ('battle_points_v3', 'vote_tournament_v1'));

ALTER TABLE public.arena_tournaments
  DROP CONSTRAINT IF EXISTS arena_tournaments_competition_generation_check;
ALTER TABLE public.arena_tournaments
  ADD CONSTRAINT arena_tournaments_competition_generation_check
  CHECK (competition_generation IN ('arena_competition_v1', 'arena_competition_v2'));

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_battle_mode_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_battle_mode_check
  CHECK (battle_mode IN ('normal', 'vote'));

ALTER TABLE public.arena_battles
  ADD COLUMN IF NOT EXISTS contest_scoring_version text,
  ADD COLUMN IF NOT EXISTS competition_generation text NOT NULL DEFAULT 'arena_competition_v1';

UPDATE public.arena_battles
   SET contest_scoring_version = CASE
     WHEN battle_mode = 'vote' THEN 'vote_tournament_v1'
     WHEN source = 'tournament' THEN 'battle_points_v3'
     ELSE CASE
       WHEN settlement_scoring_version IS NOT NULL THEN settlement_scoring_version
       WHEN COALESCE(settlement_version, 0) >= 2 THEN 'battle_points_v2'
       ELSE 'mcap_pct_change'
     END
   END
 WHERE contest_scoring_version IS NULL;

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_contest_scoring_version_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_contest_scoring_version_check
  CHECK (
    contest_scoring_version IS NULL
    OR contest_scoring_version IN ('mcap_pct_change', 'battle_points_v2', 'battle_points_v3', 'vote_tournament_v1')
  );

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_competition_generation_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_competition_generation_check
  CHECK (competition_generation IN ('arena_competition_v1', 'arena_competition_v2'));

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_settlement_scoring_version_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_settlement_scoring_version_check CHECK (
    settlement_scoring_version IS NULL
    OR settlement_scoring_version IN ('mcap_pct_change', 'battle_points_v2', 'battle_points_v3', 'vote_tournament_v1')
  );

ALTER TABLE public.arena_war_pools
  ADD COLUMN IF NOT EXISTS pool_generation text NOT NULL DEFAULT 'war_pool_v1',
  ADD COLUMN IF NOT EXISTS scoring_version text,
  ADD COLUMN IF NOT EXISTS allocation_version text NOT NULL DEFAULT 'winner85_mwl10_protocol5';

ALTER TABLE public.arena_war_pools
  DROP CONSTRAINT IF EXISTS arena_war_pools_pool_generation_check;
ALTER TABLE public.arena_war_pools
  ADD CONSTRAINT arena_war_pools_pool_generation_check
  CHECK (pool_generation IN ('war_pool_v1', 'war_pool_v2'));

ALTER TABLE public.arena_war_pools
  DROP CONSTRAINT IF EXISTS arena_war_pools_scoring_version_check;
ALTER TABLE public.arena_war_pools
  ADD CONSTRAINT arena_war_pools_scoring_version_check
  CHECK (
    scoring_version IS NULL
    OR scoring_version IN ('mcap_pct_change', 'battle_points_v2', 'battle_points_v3', 'vote_tournament_v1')
  );

ALTER TABLE public.arena_war_pools
  DROP CONSTRAINT IF EXISTS arena_war_pools_allocation_version_check;
ALTER TABLE public.arena_war_pools
  ADD CONSTRAINT arena_war_pools_allocation_version_check
  CHECK (allocation_version IN ('winner85_mwl10_protocol5', 'prize75_league20_protocol5'));

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

  IF tournament_round_hours <> 24 THEN
    RAISE EXCEPTION 'Tournament % must remain founder-locked to 24-hour rounds', NEW.tournament_id;
  END IF;

  NEW.ends_at := NEW.started_at + interval '24 hours';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS public.arena_contest_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_id integer NOT NULL,
  tournament_id text REFERENCES public.arena_tournaments(id) ON DELETE CASCADE,
  battle_id text NOT NULL REFERENCES public.arena_battles(id) ON DELETE CASCADE,
  match_id text,
  round_number integer NOT NULL CHECK (round_number >= 1),
  phase text NOT NULL,
  salvo_index integer,
  side text NOT NULL,
  wallet text NOT NULL,
  action_type text NOT NULL,
  boost_units bigint NOT NULL DEFAULT 0 CHECK (boost_units >= 0),
  points integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  gross_native_raw bigint NOT NULL DEFAULT 0 CHECK (gross_native_raw >= 0),
  pool_native_raw bigint NOT NULL DEFAULT 0 CHECK (pool_native_raw >= 0),
  protocol_native_raw bigint NOT NULL DEFAULT 0 CHECK (protocol_native_raw >= 0),
  tx_hash text,
  log_index integer,
  signature_reference text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  confirmed_at timestamptz,
  CONSTRAINT arena_contest_actions_phase_check CHECK (phase IN ('regulation', 'salvo', 'sudden_death')),
  CONSTRAINT arena_contest_actions_side_check CHECK (side IN ('left', 'right')),
  CONSTRAINT arena_contest_actions_action_type_check CHECK (action_type IN ('free_vote', 'boost')),
  CONSTRAINT arena_contest_actions_salvo_index_check CHECK (
    (phase = 'regulation' AND salvo_index IS NULL)
    OR (phase IN ('salvo', 'sudden_death') AND salvo_index IS NOT NULL AND salvo_index >= 1)
  ),
  CONSTRAINT arena_contest_actions_boost_phase_check CHECK (
    (action_type = 'boost' AND phase = 'regulation')
    OR action_type = 'free_vote'
  ),
  CONSTRAINT arena_contest_actions_free_vote_amounts_check CHECK (
    (action_type = 'free_vote' AND boost_units = 0 AND pool_native_raw = 0 AND protocol_native_raw = 0)
    OR action_type = 'boost'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS arena_contest_actions_regulation_free_vote_uidx
  ON public.arena_contest_actions (
    COALESCE(match_id, battle_id),
    round_number,
    phase,
    wallet
  )
  WHERE action_type = 'free_vote' AND phase = 'regulation';

CREATE UNIQUE INDEX IF NOT EXISTS arena_contest_actions_salvo_free_vote_uidx
  ON public.arena_contest_actions (
    COALESCE(match_id, battle_id),
    round_number,
    phase,
    salvo_index,
    wallet
  )
  WHERE action_type = 'free_vote' AND phase IN ('salvo', 'sudden_death');

CREATE UNIQUE INDEX IF NOT EXISTS arena_contest_actions_tx_uidx
  ON public.arena_contest_actions (chain_id, tx_hash, log_index)
  WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL;

CREATE INDEX IF NOT EXISTS arena_contest_actions_match_idx
  ON public.arena_contest_actions (tournament_id, battle_id, round_number, phase, side, created_at DESC);

CREATE TABLE IF NOT EXISTS public.arena_vote_tiebreaks (
  battle_id text PRIMARY KEY REFERENCES public.arena_battles(id) ON DELETE CASCADE,
  tournament_id text REFERENCES public.arena_tournaments(id) ON DELETE CASCADE,
  round_number integer NOT NULL CHECK (round_number >= 1),
  state text NOT NULL DEFAULT 'pending',
  regulation_left_points integer NOT NULL DEFAULT 0 CHECK (regulation_left_points >= 0),
  regulation_right_points integer NOT NULL DEFAULT 0 CHECK (regulation_right_points >= 0),
  current_salvo_index integer NOT NULL DEFAULT 0 CHECK (current_salvo_index >= 0),
  left_salvo_points integer NOT NULL DEFAULT 0 CHECK (left_salvo_points >= 0),
  right_salvo_points integer NOT NULL DEFAULT 0 CHECK (right_salvo_points >= 0),
  shot_started_at timestamptz,
  shot_ends_at timestamptz,
  shot_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  left_current_unique_votes integer NOT NULL DEFAULT 0 CHECK (left_current_unique_votes >= 0),
  right_current_unique_votes integer NOT NULL DEFAULT 0 CHECK (right_current_unique_votes >= 0),
  sudden_death_round integer NOT NULL DEFAULT 0 CHECK (sudden_death_round >= 0),
  winner_side text,
  paused_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_vote_tiebreaks_state_check CHECK (state IN ('pending', 'salvo', 'sudden_death', 'resolved', 'paused')),
  CONSTRAINT arena_vote_tiebreaks_winner_side_check CHECK (winner_side IS NULL OR winner_side IN ('left', 'right')),
  CONSTRAINT arena_vote_tiebreaks_history_array_check CHECK (jsonb_typeof(shot_history) = 'array')
);

DROP TRIGGER IF EXISTS set_arena_vote_tiebreaks_updated_at ON public.arena_vote_tiebreaks;
CREATE TRIGGER set_arena_vote_tiebreaks_updated_at
BEFORE UPDATE ON public.arena_vote_tiebreaks
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.arena_battle_points_v3 (
  battle_id text NOT NULL REFERENCES public.arena_battles(id) ON DELETE CASCADE,
  token_id text NOT NULL,
  side text NOT NULL,
  scoring_version text NOT NULL DEFAULT 'battle_points_v3',
  mcap_weight integer NOT NULL DEFAULT 45,
  holder_weight integer NOT NULL DEFAULT 27,
  volume_weight integer NOT NULL DEFAULT 18,
  boost_weight integer NOT NULL DEFAULT 10,
  boost_curve_version text NOT NULL DEFAULT 'founder_pending',
  boost_curve_parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  boost_units bigint NOT NULL DEFAULT 0 CHECK (boost_units >= 0),
  boost_gross_native_raw bigint NOT NULL DEFAULT 0 CHECK (boost_gross_native_raw >= 0),
  boost_pool_native_raw bigint NOT NULL DEFAULT 0 CHECK (boost_pool_native_raw >= 0),
  boost_protocol_native_raw bigint NOT NULL DEFAULT 0 CHECK (boost_protocol_native_raw >= 0),
  boost_points numeric,
  mcap_points numeric,
  holder_points numeric,
  volume_points numeric,
  total_points numeric,
  metrics_updated_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (battle_id, side),
  CONSTRAINT arena_battle_points_v3_side_check CHECK (side IN ('left', 'right')),
  CONSTRAINT arena_battle_points_v3_scoring_check CHECK (scoring_version = 'battle_points_v3'),
  CONSTRAINT arena_battle_points_v3_parameters_object_check CHECK (jsonb_typeof(boost_curve_parameters) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS arena_battle_points_v3_battle_token_uidx
  ON public.arena_battle_points_v3 (battle_id, token_id);

DROP TRIGGER IF EXISTS set_arena_battle_points_v3_updated_at ON public.arena_battle_points_v3;
CREATE TRIGGER set_arena_battle_points_v3_updated_at
BEFORE UPDATE ON public.arena_battle_points_v3
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.arena_postgrad_league_v2_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_id integer NOT NULL,
  monthly_epoch text NOT NULL,
  quarterly_epoch text NOT NULL,
  source_pool text NOT NULL,
  raw_native_amount bigint NOT NULL CHECK (raw_native_amount >= 0),
  monthly_share_bps integer NOT NULL DEFAULT 6000 CHECK (monthly_share_bps = 6000),
  quarterly_share_bps integer NOT NULL DEFAULT 4000 CHECK (quarterly_share_bps = 4000),
  tx_hash text,
  signature_reference text,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS arena_postgrad_league_v2_ledger_epoch_idx
  ON public.arena_postgrad_league_v2_ledger (chain_id, monthly_epoch, quarterly_epoch, created_at DESC);

CREATE TABLE IF NOT EXISTS public.sponsor_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_name text NOT NULL,
  website_url text,
  logo_url text,
  contact_name text,
  contact_channel text,
  wallet text NOT NULL,
  verified_wallet text,
  status text NOT NULL DEFAULT 'pending',
  founding_sponsor boolean NOT NULL DEFAULT false,
  founding_sponsor_badge text,
  approved_at timestamptz,
  approved_by text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT sponsor_profiles_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'disabled'))
);

DROP TRIGGER IF EXISTS set_sponsor_profiles_updated_at ON public.sponsor_profiles;
CREATE TRIGGER set_sponsor_profiles_updated_at
BEFORE UPDATE ON public.sponsor_profiles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.sponsorship_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  event_reference_id text NOT NULL,
  chain_id integer NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  sponsorship_open boolean NOT NULL DEFAULT false,
  prize_native_raw bigint NOT NULL DEFAULT 0 CHECK (prize_native_raw >= 0),
  sponsorship_prize_native_raw bigint NOT NULL DEFAULT 0 CHECK (sponsorship_prize_native_raw >= 0),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT sponsorship_events_event_type_check CHECK (
    event_type IN ('normal_tournament', 'vote_tournament', 'monthly_mwl', 'quarterly_championship')
  )
);

DROP TRIGGER IF EXISTS set_sponsorship_events_updated_at ON public.sponsorship_events;
CREATE TRIGGER set_sponsorship_events_updated_at
BEFORE UPDATE ON public.sponsorship_events
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_events_reference_uidx
  ON public.sponsorship_events (event_type, event_reference_id, chain_id);

CREATE TABLE IF NOT EXISTS public.sponsorship_price_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  min_qualified_users integer NOT NULL CHECK (min_qualified_users >= 0),
  max_qualified_users integer,
  tournament_min_usd_cents bigint NOT NULL CHECK (tournament_min_usd_cents >= 0),
  mwl_min_usd_cents bigint NOT NULL CHECK (mwl_min_usd_cents >= 0),
  quarterly_min_usd_cents bigint NOT NULL CHECK (quarterly_min_usd_cents >= 0),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  effective_from timestamptz NOT NULL DEFAULT NOW(),
  effective_until timestamptz,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT sponsorship_price_tiers_range_check CHECK (
    max_qualified_users IS NULL OR max_qualified_users >= min_qualified_users
  )
);

DROP TRIGGER IF EXISTS set_sponsorship_price_tiers_updated_at ON public.sponsorship_price_tiers;
CREATE TRIGGER set_sponsorship_price_tiers_updated_at
BEFORE UPDATE ON public.sponsorship_price_tiers
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.sponsorship_price_tiers (
  code,
  label,
  min_qualified_users,
  max_qualified_users,
  tournament_min_usd_cents,
  mwl_min_usd_cents,
  quarterly_min_usd_cents,
  sort_order
)
VALUES
  ('FOUNDING', 'Founding', 0, 999, 4900, 9900, 24900, 10),
  ('EARLY', 'Early', 1000, 4999, 9900, 19900, 49900, 20),
  ('GROWING', 'Growing', 5000, 24999, 24900, 49900, 119900, 30),
  ('ESTABLISHED', 'Established', 25000, 99999, 59900, 119900, 299900, 40),
  ('LARGE', 'Large', 100000, 499999, 149900, 299900, 749900, 50),
  ('MAJOR', 'Major', 500000, NULL, 299900, 749900, 1500000, 60)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  min_qualified_users = EXCLUDED.min_qualified_users,
  max_qualified_users = EXCLUDED.max_qualified_users,
  tournament_min_usd_cents = EXCLUDED.tournament_min_usd_cents,
  mwl_min_usd_cents = EXCLUDED.mwl_min_usd_cents,
  quarterly_min_usd_cents = EXCLUDED.quarterly_min_usd_cents,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

CREATE TABLE IF NOT EXISTS public.sponsorship_price_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL,
  scope_id text,
  chain_id integer,
  event_type text,
  min_usd_cents bigint NOT NULL CHECK (min_usd_cents >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  reason text,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT sponsorship_price_overrides_scope_check CHECK (scope_type IN ('event', 'chain')),
  CONSTRAINT sponsorship_price_overrides_target_check CHECK (
    (scope_type = 'event' AND scope_id IS NOT NULL)
    OR (scope_type = 'chain' AND chain_id IS NOT NULL)
  ),
  CONSTRAINT sponsorship_price_overrides_event_type_check CHECK (
    event_type IS NULL OR event_type IN ('normal_tournament', 'vote_tournament', 'monthly_mwl', 'quarterly_championship')
  )
);

CREATE TABLE IF NOT EXISTS public.sponsorship_traffic_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date NOT NULL,
  rolling_30d_qualified_users integer NOT NULL CHECK (rolling_30d_qualified_users >= 0),
  connected_wallets integer,
  warzone_unique_users integer,
  tournament_viewers integer,
  tournament_voters integer,
  recommended_tier_id uuid REFERENCES public.sponsorship_price_tiers(id),
  active_tier_id uuid REFERENCES public.sponsorship_price_tiers(id),
  calculation_version text NOT NULL DEFAULT 'v1',
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS sponsorship_traffic_snapshots_snapshot_uidx
  ON public.sponsorship_traffic_snapshots (snapshot_date);

CREATE TABLE IF NOT EXISTS public.sponsorship_payment_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.sponsorship_events(id) ON DELETE CASCADE,
  chain_id integer NOT NULL,
  sponsor_profile_id uuid REFERENCES public.sponsor_profiles(id) ON DELETE SET NULL,
  sponsor_wallet text NOT NULL,
  pricing_tier_id uuid REFERENCES public.sponsorship_price_tiers(id) ON DELETE SET NULL,
  pricing_version text NOT NULL,
  minimum_usd_cents bigint NOT NULL CHECK (minimum_usd_cents >= 0),
  requested_usd_cents bigint,
  requested_native_raw bigint,
  minimum_native_raw bigint NOT NULL CHECK (minimum_native_raw >= 0),
  native_usd_reference_micro_cents bigint NOT NULL CHECK (native_usd_reference_micro_cents >= 0),
  oracle_timestamp timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  nonce text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, sponsor_wallet, nonce)
);

CREATE TABLE IF NOT EXISTS public.event_sponsorships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.sponsorship_events(id) ON DELETE CASCADE,
  sponsor_profile_id uuid NOT NULL REFERENCES public.sponsor_profiles(id) ON DELETE CASCADE,
  pricing_tier_id uuid REFERENCES public.sponsorship_price_tiers(id) ON DELETE SET NULL,
  quote_id uuid REFERENCES public.sponsorship_payment_quotes(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'quoted',
  gross_native_raw bigint NOT NULL DEFAULT 0 CHECK (gross_native_raw >= 0),
  prize_native_raw bigint NOT NULL DEFAULT 0 CHECK (prize_native_raw >= 0),
  marketing_native_raw bigint NOT NULL DEFAULT 0 CHECK (marketing_native_raw >= 0),
  protocol_native_raw bigint NOT NULL DEFAULT 0 CHECK (protocol_native_raw >= 0),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT event_sponsorships_status_check CHECK (status IN ('quoted', 'pending_payment', 'active', 'expired', 'cancelled', 'paid'))
);

DROP TRIGGER IF EXISTS set_event_sponsorships_updated_at ON public.event_sponsorships;
CREATE TRIGGER set_event_sponsorships_updated_at
BEFORE UPDATE ON public.event_sponsorships
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.sponsorship_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_sponsorship_id uuid NOT NULL REFERENCES public.event_sponsorships(id) ON DELETE CASCADE,
  quote_id uuid REFERENCES public.sponsorship_payment_quotes(id) ON DELETE SET NULL,
  chain_id integer NOT NULL,
  gross_native_raw bigint NOT NULL CHECK (gross_native_raw >= 0),
  prize_native_raw bigint NOT NULL CHECK (prize_native_raw >= 0),
  marketing_native_raw bigint NOT NULL CHECK (marketing_native_raw >= 0),
  protocol_native_raw bigint NOT NULL CHECK (protocol_native_raw >= 0),
  tx_hash text,
  signature_reference text,
  status text NOT NULL DEFAULT 'pending',
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT sponsorship_payments_status_check CHECK (status IN ('pending', 'confirmed', 'failed', 'refunded'))
);

REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_contest_actions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_vote_tiebreaks FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_battle_points_v3 FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_postgrad_league_v2_ledger FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsor_profiles FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsorship_events FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsorship_price_tiers FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsorship_price_overrides FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsorship_traffic_snapshots FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsorship_payment_quotes FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.event_sponsorships FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsorship_payments FROM anon, authenticated;

GRANT SELECT ON TABLE public.arena_contest_actions TO anon, authenticated;
GRANT SELECT ON TABLE public.arena_vote_tiebreaks TO anon, authenticated;
GRANT SELECT ON TABLE public.arena_battle_points_v3 TO anon, authenticated;
GRANT SELECT ON TABLE public.sponsorship_events TO anon, authenticated;
GRANT SELECT ON TABLE public.sponsorship_price_tiers TO anon, authenticated;
GRANT SELECT ON TABLE public.sponsorship_traffic_snapshots TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_contest_actions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_vote_tiebreaks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_battle_points_v3 TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_postgrad_league_v2_ledger TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sponsor_profiles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sponsorship_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sponsorship_price_tiers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sponsorship_price_overrides TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sponsorship_traffic_snapshots TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sponsorship_payment_quotes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.event_sponsorships TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sponsorship_payments TO service_role;

ALTER TABLE public.arena_contest_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_vote_tiebreaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_battle_points_v3 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_postgrad_league_v2_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sponsor_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sponsorship_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sponsorship_price_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sponsorship_price_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sponsorship_traffic_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sponsorship_payment_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_sponsorships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sponsorship_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS arena_contest_actions_public_read ON public.arena_contest_actions;
CREATE POLICY arena_contest_actions_public_read ON public.arena_contest_actions FOR SELECT USING (true);

DROP POLICY IF EXISTS arena_vote_tiebreaks_public_read ON public.arena_vote_tiebreaks;
CREATE POLICY arena_vote_tiebreaks_public_read ON public.arena_vote_tiebreaks FOR SELECT USING (true);

DROP POLICY IF EXISTS arena_battle_points_v3_public_read ON public.arena_battle_points_v3;
CREATE POLICY arena_battle_points_v3_public_read ON public.arena_battle_points_v3 FOR SELECT USING (true);

DROP POLICY IF EXISTS sponsorship_events_public_read ON public.sponsorship_events;
CREATE POLICY sponsorship_events_public_read ON public.sponsorship_events FOR SELECT USING (true);

DROP POLICY IF EXISTS sponsorship_price_tiers_public_read ON public.sponsorship_price_tiers;
CREATE POLICY sponsorship_price_tiers_public_read ON public.sponsorship_price_tiers FOR SELECT USING (true);

COMMENT ON COLUMN public.arena_tournaments.contest_scoring_version IS
  'Founder-locked path selection: normal tournaments point at future Battle Points V3, vote tournaments point at vote_tournament_v1.';
COMMENT ON COLUMN public.arena_battles.contest_scoring_version IS
  'Tournament battles inherit their competition scoring path without rewriting historical settlement evidence.';
COMMENT ON COLUMN public.arena_war_pools.pool_generation IS
  'Historical war_pool_v1 remains readable; future V2 competition pools must be stored as war_pool_v2.';

COMMIT;
