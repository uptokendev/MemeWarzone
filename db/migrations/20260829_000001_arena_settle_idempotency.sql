-- 4a.2: persist MWL vs money settlement snapshots and make battle ledger writes idempotent.
BEGIN;

ALTER TABLE public.arena_battles
  ADD COLUMN IF NOT EXISTS challenger_end_mcap_usd numeric,
  ADD COLUMN IF NOT EXISTS defender_end_mcap_usd numeric,
  ADD COLUMN IF NOT EXISTS challenger_pct_change numeric,
  ADD COLUMN IF NOT EXISTS defender_pct_change numeric,
  ADD COLUMN IF NOT EXISTS mwl_result text,
  ADD COLUMN IF NOT EXISTS mwl_draw boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mwl_winner_token text,
  ADD COLUMN IF NOT EXISTS money_winner_token text,
  ADD COLUMN IF NOT EXISTS money_tie_break text,
  ADD COLUMN IF NOT EXISTS settlement_version integer,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz;

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_mwl_result_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_mwl_result_check CHECK (
    mwl_result IS NULL OR mwl_result IN ('left_win', 'right_win', 'draw')
  );

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_money_tie_break_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_money_tie_break_check CHECK (
    money_tie_break IS NULL OR money_tie_break IN ('performance', 'ending_mcap', 'token_address')
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.arena_league_point_events
     WHERE battle_id IS NOT NULL
       AND kind IN ('battle_win', 'battle_loss', 'battle_draw')
     GROUP BY season_id, battle_id, token_address, kind
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'arena settle migration blocked: duplicate battle MWL events require review';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS arena_league_point_events_battle_token_kind_idx
  ON public.arena_league_point_events (season_id, battle_id, token_address, kind)
  WHERE battle_id IS NOT NULL AND kind IN ('battle_win', 'battle_loss', 'battle_draw');

COMMIT;
