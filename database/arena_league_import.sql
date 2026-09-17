-- MemeBattles Arena League database import
-- Run in Supabase SQL Editor or psql against the MemeBattles Postgres database.
-- This makes league season state, standings, and season history durable.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS public.arena_league_seasons (
  id text PRIMARY KEY,
  label text NOT NULL,
  state text NOT NULL DEFAULT 'preseason',
  week integer NOT NULL DEFAULT 1,
  reward_pool_usd numeric NOT NULL DEFAULT 0,
  reset_at timestamptz NOT NULL DEFAULT (NOW() + interval '7 days'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_league_seasons_state_check CHECK (state IN ('preseason', 'live', 'playoffs', 'completed')),
  CONSTRAINT arena_league_seasons_week_check CHECK (week >= 1),
  CONSTRAINT arena_league_seasons_reward_check CHECK (reward_pool_usd >= 0),
  CONSTRAINT arena_league_seasons_label_length CHECK (char_length(label) <= 120)
);

DROP TRIGGER IF EXISTS set_arena_league_seasons_updated_at ON public.arena_league_seasons;
CREATE TRIGGER set_arena_league_seasons_updated_at
BEFORE UPDATE ON public.arena_league_seasons
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS arena_league_one_active_season_idx
  ON public.arena_league_seasons (chain_id)
  WHERE active = true;

CREATE TABLE IF NOT EXISTS public.arena_league_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id text NOT NULL REFERENCES public.arena_league_seasons(id) ON DELETE CASCADE,
  token_id text NOT NULL,
  token_name text NOT NULL,
  symbol text NOT NULL,
  division text NOT NULL DEFAULT 'bronze',
  points numeric NOT NULL DEFAULT 0,
  wins integer NOT NULL DEFAULT 0,
  losses integer NOT NULL DEFAULT 0,
  streak integer NOT NULL DEFAULT 0,
  movement text NOT NULL DEFAULT 'safe',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_league_entries_unique_token UNIQUE (season_id, token_id),
  CONSTRAINT arena_league_entries_division_check CHECK (division IN ('bronze', 'silver', 'gold', 'apex')),
  CONSTRAINT arena_league_entries_movement_check CHECK (movement IN ('promoted', 'safe', 'relegated')),
  CONSTRAINT arena_league_entries_points_check CHECK (points >= 0),
  CONSTRAINT arena_league_entries_wins_check CHECK (wins >= 0),
  CONSTRAINT arena_league_entries_losses_check CHECK (losses >= 0),
  CONSTRAINT arena_league_entries_token_name_length CHECK (char_length(token_name) <= 120),
  CONSTRAINT arena_league_entries_symbol_length CHECK (char_length(symbol) <= 24)
);

DROP TRIGGER IF EXISTS set_arena_league_entries_updated_at ON public.arena_league_entries;
CREATE TRIGGER set_arena_league_entries_updated_at
BEFORE UPDATE ON public.arena_league_entries
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS arena_league_entries_standings_idx
  ON public.arena_league_entries (season_id, division, points DESC, wins DESC);

CREATE TABLE IF NOT EXISTS public.arena_league_history (
  season_id text PRIMARY KEY,
  label text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT NOW(),
  reward_pool_usd numeric NOT NULL DEFAULT 0,
  week integer NOT NULL DEFAULT 1,
  top_token_name text NOT NULL DEFAULT 'Unknown',
  top_token_symbol text NOT NULL DEFAULT '---',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_league_history_reward_check CHECK (reward_pool_usd >= 0),
  CONSTRAINT arena_league_history_week_check CHECK (week >= 1),
  CONSTRAINT arena_league_history_label_length CHECK (char_length(label) <= 120),
  CONSTRAINT arena_league_history_top_name_length CHECK (char_length(top_token_name) <= 120),
  CONSTRAINT arena_league_history_top_symbol_length CHECK (char_length(top_token_symbol) <= 24)
);

DROP TRIGGER IF EXISTS set_arena_league_history_updated_at ON public.arena_league_history;
CREATE TRIGGER set_arena_league_history_updated_at
BEFORE UPDATE ON public.arena_league_history
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS arena_league_history_completed_idx
  ON public.arena_league_history (completed_at DESC);

INSERT INTO public.arena_league_seasons (id, label, state, week, reward_pool_usd, reset_at, active)
VALUES ('season-01', 'Season One', 'live', 4, 150000, NOW() + interval '6 days', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.arena_league_entries (
  season_id,
  token_id,
  token_name,
  symbol,
  division,
  points,
  wins,
  losses,
  streak,
  movement
) VALUES
  ('season-01', 'redline-rats', 'Redline Rats', 'RATS', 'apex', 144, 12, 2, 4, 'promoted'),
  ('season-01', 'storm-doge', 'Storm Doge', 'SDOGE', 'gold', 131, 11, 3, 3, 'promoted'),
  ('season-01', 'moon-ops', 'Moon Ops', 'MOPS', 'gold', 118, 9, 4, 1, 'safe'),
  ('season-01', 'glitch-ape', 'Glitch Ape', 'GAPE', 'silver', 94, 7, 6, -1, 'safe'),
  ('season-01', 'astro-frogs', 'Astro Frogs', 'AFRG', 'silver', 81, 6, 7, 2, 'safe'),
  ('season-01', 'neon-shib', 'Neon Shib', 'NSHB', 'bronze', 63, 4, 8, -2, 'relegated')
ON CONFLICT (season_id, token_id) DO NOTHING;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.arena_league_seasons TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.arena_league_entries TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.arena_league_history TO anon, authenticated;

-- Keep RLS disabled for the current build path. Later we should move league admin
-- actions behind authenticated/admin endpoints and enable policies.
ALTER TABLE public.arena_league_seasons DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_league_entries DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_league_history DISABLE ROW LEVEL SECURITY;

COMMIT;
