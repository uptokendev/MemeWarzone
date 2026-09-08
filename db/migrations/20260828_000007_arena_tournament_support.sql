-- Tournament Support: one event pot, overall champion takes 85/5/10 once.
-- Support is a donation to a roster memecoin. Supporters are never paid.
-- Canonical. Copy for other branches: docs/build_plans/arena-tournament-support-migration.sql

BEGIN;

ALTER TABLE public.arena_tournaments
  ADD COLUMN IF NOT EXISTS winner_token text;

-- Production acquired this table via database/arena_war_pools_import.sql, which
-- is outside db/migrations. CREATE IF NOT EXISTS makes empty-DB replay succeed
-- without changing existing Supabase history.
CREATE TABLE IF NOT EXISTS public.arena_war_pools (
  battle_id text PRIMARY KEY,
  state text NOT NULL DEFAULT 'open',
  cutoff_at timestamptz NOT NULL DEFAULT (NOW() + interval '30 minutes'),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_war_pools_state_check CHECK (state IN ('open', 'locked', 'settling', 'paid'))
);

DROP TRIGGER IF EXISTS set_arena_war_pools_updated_at ON public.arena_war_pools;
CREATE TRIGGER set_arena_war_pools_updated_at
BEFORE UPDATE ON public.arena_war_pools
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS arena_war_pools_state_idx
  ON public.arena_war_pools (state, updated_at DESC);

ALTER TABLE public.arena_war_pools
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'battle';

ALTER TABLE public.arena_war_pools
  DROP CONSTRAINT IF EXISTS arena_war_pools_kind_check;
ALTER TABLE public.arena_war_pools
  ADD CONSTRAINT arena_war_pools_kind_check CHECK (kind IN ('battle', 'tournament'));

ALTER TABLE public.arena_support_entries
  ADD COLUMN IF NOT EXISTS tournament_id text;

ALTER TABLE public.arena_support_entries
  ALTER COLUMN battle_id DROP NOT NULL;

ALTER TABLE public.arena_support_entries
  DROP CONSTRAINT IF EXISTS arena_support_entries_subject_check;
ALTER TABLE public.arena_support_entries
  ADD CONSTRAINT arena_support_entries_subject_check CHECK (
    (battle_id IS NOT NULL AND tournament_id IS NULL)
    OR (battle_id IS NULL AND tournament_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS arena_support_entries_tournament_idx
  ON public.arena_support_entries (tournament_id, side_token)
  WHERE tournament_id IS NOT NULL;

COMMIT;
