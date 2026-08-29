-- Major War League scorecard: append-only point ledger, daily check-in, War Dispatch, QF freeze.
BEGIN;

ALTER TABLE public.arena_league_seasons
  ADD COLUMN IF NOT EXISTS frozen_at timestamptz,
  ADD COLUMN IF NOT EXISTS regular_season_closed boolean NOT NULL DEFAULT false;

ALTER TABLE public.arena_league_entries
  ADD COLUMN IF NOT EXISTS finished_fights integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checkin_streak integer NOT NULL DEFAULT 0;

ALTER TABLE public.arena_league_entries
  DROP CONSTRAINT IF EXISTS arena_league_entries_fights_check;
ALTER TABLE public.arena_league_entries
  ADD CONSTRAINT arena_league_entries_fights_check CHECK (finished_fights >= 0);
ALTER TABLE public.arena_league_entries
  DROP CONSTRAINT IF EXISTS arena_league_entries_checkin_streak_check;
ALTER TABLE public.arena_league_entries
  ADD CONSTRAINT arena_league_entries_checkin_streak_check CHECK (checkin_streak >= 0);

CREATE TABLE IF NOT EXISTS public.arena_league_point_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id text NOT NULL REFERENCES public.arena_league_seasons(id) ON DELETE CASCADE,
  token_address text NOT NULL,
  kind text NOT NULL,
  points numeric(12,2) NOT NULL DEFAULT 0,
  wallet text,
  battle_id text,
  pair_key text,
  utc_day date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_league_point_events_kind_check CHECK (
    kind IN (
      'battle_win',
      'battle_loss',
      'battle_draw',
      'tournament_win_bonus',
      'checkin',
      'streak_bonus',
      'dispatch'
    )
  )
);

CREATE INDEX IF NOT EXISTS arena_league_point_events_season_idx
  ON public.arena_league_point_events (season_id, created_at DESC);
CREATE INDEX IF NOT EXISTS arena_league_point_events_pair_idx
  ON public.arena_league_point_events (season_id, pair_key, created_at DESC)
  WHERE pair_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS arena_league_point_events_activity_day_idx
  ON public.arena_league_point_events (season_id, lower(wallet), utc_day, kind)
  WHERE kind IN ('checkin', 'streak_bonus', 'dispatch') AND wallet IS NOT NULL AND utc_day IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.arena_creator_checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id text NOT NULL REFERENCES public.arena_league_seasons(id) ON DELETE CASCADE,
  wallet text NOT NULL,
  token_address text NOT NULL,
  utc_day date NOT NULL,
  streak_days integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_creator_checkins_unique UNIQUE (wallet, utc_day),
  CONSTRAINT arena_creator_checkins_streak_check CHECK (streak_days >= 1)
);

CREATE TABLE IF NOT EXISTS public.arena_war_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id text NOT NULL REFERENCES public.arena_league_seasons(id) ON DELETE CASCADE,
  wallet text NOT NULL,
  token_address text NOT NULL,
  utc_day date NOT NULL,
  card_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_war_dispatches_unique UNIQUE (wallet, utc_day)
);

REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_league_point_events FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_creator_checkins FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_war_dispatches FROM anon, authenticated;

GRANT SELECT ON TABLE public.arena_league_point_events TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_league_point_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_creator_checkins TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_war_dispatches TO service_role;

ALTER TABLE public.arena_league_point_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_creator_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_war_dispatches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS arena_league_point_events_public_read ON public.arena_league_point_events;
CREATE POLICY arena_league_point_events_public_read ON public.arena_league_point_events FOR SELECT USING (true);

COMMIT;
