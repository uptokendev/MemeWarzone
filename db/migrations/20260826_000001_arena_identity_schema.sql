-- Arena identity schema (Phase 0).
-- Public feeds are SELECT-only for anon/authenticated. Writes go through the API (service_role).
-- Do not seed fake battles, tokens, or events.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Battles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.arena_battles (
  id text PRIMARY KEY,
  chain_id integer NOT NULL,
  state text NOT NULL DEFAULT 'waiting',
  source text NOT NULL DEFAULT 'queue',
  stake_native numeric NOT NULL DEFAULT 0,
  native_symbol text NOT NULL DEFAULT 'BNB',
  challenger_token text,
  defender_token text,
  tournament_id text,
  participants jsonb NOT NULL DEFAULT '[]'::jsonb,
  challenger_start_mcap_usd numeric,
  defender_start_mcap_usd numeric,
  winner_token text,
  started_at timestamptz,
  ends_at timestamptz,
  finished_at timestamptz,
  creator_address text,
  featured boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_battles_state_check CHECK (
    state IN ('waiting', 'challenged', 'live', 'finished', 'expired')
  ),
  CONSTRAINT arena_battles_source_check CHECK (
    source IN ('queue', 'challenge', 'tournament')
  ),
  CONSTRAINT arena_battles_stake_check CHECK (stake_native >= 0),
  CONSTRAINT arena_battles_participants_array_check CHECK (jsonb_typeof(participants) = 'array')
);

DROP TRIGGER IF EXISTS set_arena_battles_updated_at ON public.arena_battles;
CREATE TRIGGER set_arena_battles_updated_at
BEFORE UPDATE ON public.arena_battles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS arena_battles_feed_idx
  ON public.arena_battles (state, chain_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS arena_battles_tokens_idx
  ON public.arena_battles (chain_id, challenger_token, defender_token);

-- ---------------------------------------------------------------------------
-- Token imports (non-MemeWarzone coins)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.arena_token_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id integer NOT NULL,
  token_address text NOT NULL,
  owner_wallet text NOT NULL,
  name text,
  symbol text,
  status text NOT NULL DEFAULT 'scanning',
  scan_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_requested_at timestamptz,
  review_reason text,
  reviewer text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_token_imports_status_check CHECK (
    status IN ('scanning', 'passed', 'needs_review', 'declined')
  ),
  CONSTRAINT arena_token_imports_unique UNIQUE (chain_id, token_address)
);

DROP TRIGGER IF EXISTS set_arena_token_imports_updated_at ON public.arena_token_imports;
CREATE TRIGGER set_arena_token_imports_updated_at
BEFORE UPDATE ON public.arena_token_imports
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS arena_token_imports_owner_idx
  ON public.arena_token_imports (owner_wallet, status);

CREATE INDEX IF NOT EXISTS arena_token_imports_review_idx
  ON public.arena_token_imports (status, review_requested_at)
  WHERE review_requested_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Tournaments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.arena_tournaments (
  id text PRIMARY KEY,
  chain_id integer NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'upcoming',
  origin text NOT NULL DEFAULT 'custom',
  registration_mode text NOT NULL DEFAULT 'open',
  buy_in_native numeric NOT NULL DEFAULT 0,
  native_symbol text NOT NULL DEFAULT 'BNB',
  terms text NOT NULL DEFAULT '',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  cap integer NOT NULL DEFAULT 16,
  bracket jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_tournaments_status_check CHECK (
    status IN ('upcoming', 'live', 'finished', 'cancelled')
  ),
  CONSTRAINT arena_tournaments_origin_check CHECK (
    origin IN ('custom', 'quarter_finals')
  ),
  CONSTRAINT arena_tournaments_registration_check CHECK (
    registration_mode IN ('invite_only', 'open', 'invite_plus_open')
  ),
  CONSTRAINT arena_tournaments_cap_check CHECK (cap >= 2),
  CONSTRAINT arena_tournaments_buy_in_check CHECK (buy_in_native >= 0)
);

DROP TRIGGER IF EXISTS set_arena_tournaments_updated_at ON public.arena_tournaments;
CREATE TRIGGER set_arena_tournaments_updated_at
BEFORE UPDATE ON public.arena_tournaments
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS arena_tournaments_feed_idx
  ON public.arena_tournaments (status, chain_id, starts_at);

CREATE TABLE IF NOT EXISTS public.arena_tournament_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id text NOT NULL REFERENCES public.arena_tournaments(id) ON DELETE CASCADE,
  token_address text NOT NULL,
  owner_wallet text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_tournament_invites_status_check CHECK (
    status IN ('pending', 'accepted', 'declined', 'expired')
  ),
  CONSTRAINT arena_tournament_invites_unique UNIQUE (tournament_id, token_address)
);

DROP TRIGGER IF EXISTS set_arena_tournament_invites_updated_at ON public.arena_tournament_invites;
CREATE TRIGGER set_arena_tournament_invites_updated_at
BEFORE UPDATE ON public.arena_tournament_invites
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.arena_tournament_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id text NOT NULL REFERENCES public.arena_tournaments(id) ON DELETE CASCADE,
  token_address text NOT NULL,
  owner_wallet text NOT NULL,
  buy_in_intent boolean NOT NULL DEFAULT false,
  buy_in_paid boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_tournament_entries_unique UNIQUE (tournament_id, token_address)
);

DROP TRIGGER IF EXISTS set_arena_tournament_entries_updated_at ON public.arena_tournament_entries;
CREATE TRIGGER set_arena_tournament_entries_updated_at
BEFORE UPDATE ON public.arena_tournament_entries
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Major War League
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.arena_league_seasons (
  id text PRIMARY KEY,
  chain_id integer NOT NULL DEFAULT 56,
  label text NOT NULL,
  state text NOT NULL DEFAULT 'live',
  week integer NOT NULL DEFAULT 1,
  quarter integer NOT NULL DEFAULT 1,
  year integer NOT NULL DEFAULT EXTRACT(YEAR FROM NOW())::integer,
  reset_at timestamptz NOT NULL DEFAULT (NOW() + interval '7 days'),
  quarter_finals_tournament_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_league_seasons_state_check CHECK (
    state IN ('live', 'quarter_finals', 'completed')
  ),
  CONSTRAINT arena_league_seasons_week_check CHECK (week >= 1)
);

DROP TRIGGER IF EXISTS set_arena_league_seasons_updated_at ON public.arena_league_seasons;
CREATE TRIGGER set_arena_league_seasons_updated_at
BEFORE UPDATE ON public.arena_league_seasons
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS arena_league_one_active_season_idx
  ON public.arena_league_seasons (chain_id)
  WHERE active = true;

CREATE TABLE IF NOT EXISTS public.arena_league_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id text NOT NULL REFERENCES public.arena_league_seasons(id) ON DELETE CASCADE,
  token_address text NOT NULL,
  token_name text NOT NULL DEFAULT '',
  symbol text NOT NULL DEFAULT '',
  points numeric NOT NULL DEFAULT 0,
  wins integer NOT NULL DEFAULT 0,
  losses integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_league_entries_unique_token UNIQUE (season_id, token_address),
  CONSTRAINT arena_league_entries_points_check CHECK (points >= 0)
);

DROP TRIGGER IF EXISTS set_arena_league_entries_updated_at ON public.arena_league_entries;
CREATE TRIGGER set_arena_league_entries_updated_at
BEFORE UPDATE ON public.arena_league_entries
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Arena UpVotes (separate from launchpad campaign votes)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.arena_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_id integer NOT NULL,
  token_address text NOT NULL,
  voter_wallet text NOT NULL,
  amount_native numeric NOT NULL,
  tx_hash text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_votes_amount_check CHECK (amount_native > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS arena_votes_tx_idx
  ON public.arena_votes (chain_id, tx_hash)
  WHERE tx_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.arena_vote_aggregates (
  chain_id integer NOT NULL,
  token_address text NOT NULL,
  votes_24h integer NOT NULL DEFAULT 0,
  votes_all_time integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, token_address)
);

-- ---------------------------------------------------------------------------
-- Support donations (not betting). Payouts stay off until escrow exists.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.arena_support_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  battle_id text NOT NULL,
  side_token text NOT NULL,
  supporter_wallet text NOT NULL,
  amount_native numeric NOT NULL,
  payouts_live boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_support_entries_amount_check CHECK (amount_native > 0)
);

CREATE INDEX IF NOT EXISTS arena_support_entries_battle_idx
  ON public.arena_support_entries (battle_id, side_token);

-- ---------------------------------------------------------------------------
-- Challenge / invite email
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.wallet_notification_emails (
  wallet text PRIMARY KEY,
  email text NOT NULL,
  verified_at timestamptz,
  verify_token text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_wallet_notification_emails_updated_at ON public.wallet_notification_emails;
CREATE TRIGGER set_wallet_notification_emails_updated_at
BEFORE UPDATE ON public.wallet_notification_emails
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_battles FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_token_imports FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_tournaments FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_tournament_invites FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_tournament_entries FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_league_seasons FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_league_entries FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_votes FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_vote_aggregates FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_support_entries FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.wallet_notification_emails FROM anon, authenticated;

GRANT SELECT ON TABLE public.arena_battles TO anon, authenticated;
GRANT SELECT ON TABLE public.arena_tournaments TO anon, authenticated;
GRANT SELECT ON TABLE public.arena_tournament_entries TO anon, authenticated;
GRANT SELECT ON TABLE public.arena_league_seasons TO anon, authenticated;
GRANT SELECT ON TABLE public.arena_league_entries TO anon, authenticated;
GRANT SELECT ON TABLE public.arena_vote_aggregates TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_battles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_token_imports TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_tournaments TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_tournament_invites TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_tournament_entries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_league_seasons TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_league_entries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_votes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_vote_aggregates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_support_entries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.wallet_notification_emails TO service_role;

ALTER TABLE public.arena_battles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_token_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_tournament_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_tournament_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_league_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_league_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_vote_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_support_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_notification_emails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS arena_battles_public_read ON public.arena_battles;
CREATE POLICY arena_battles_public_read ON public.arena_battles FOR SELECT USING (true);

DROP POLICY IF EXISTS arena_tournaments_public_read ON public.arena_tournaments;
CREATE POLICY arena_tournaments_public_read ON public.arena_tournaments FOR SELECT USING (true);

DROP POLICY IF EXISTS arena_tournament_entries_public_read ON public.arena_tournament_entries;
CREATE POLICY arena_tournament_entries_public_read ON public.arena_tournament_entries FOR SELECT USING (true);

DROP POLICY IF EXISTS arena_league_seasons_public_read ON public.arena_league_seasons;
CREATE POLICY arena_league_seasons_public_read ON public.arena_league_seasons FOR SELECT USING (true);

DROP POLICY IF EXISTS arena_league_entries_public_read ON public.arena_league_entries;
CREATE POLICY arena_league_entries_public_read ON public.arena_league_entries FOR SELECT USING (true);

DROP POLICY IF EXISTS arena_vote_aggregates_public_read ON public.arena_vote_aggregates;
CREATE POLICY arena_vote_aggregates_public_read ON public.arena_vote_aggregates FOR SELECT USING (true);

COMMIT;
