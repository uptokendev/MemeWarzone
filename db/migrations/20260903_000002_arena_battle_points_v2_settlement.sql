-- Battle V2 Settlement: additive final-score evidence and V2 tie-break vocabulary.
-- Historical settlement_version=1 rows remain untouched and continue to mean MCAP % settlement.

BEGIN;

ALTER TABLE public.arena_battles
  ADD COLUMN IF NOT EXISTS settlement_scoring_version text,
  ADD COLUMN IF NOT EXISTS challenger_battle_points numeric,
  ADD COLUMN IF NOT EXISTS defender_battle_points numeric,
  ADD COLUMN IF NOT EXISTS challenger_mcap_points numeric,
  ADD COLUMN IF NOT EXISTS defender_mcap_points numeric,
  ADD COLUMN IF NOT EXISTS challenger_holder_points numeric,
  ADD COLUMN IF NOT EXISTS defender_holder_points numeric,
  ADD COLUMN IF NOT EXISTS challenger_volume_points numeric,
  ADD COLUMN IF NOT EXISTS defender_volume_points numeric,
  ADD COLUMN IF NOT EXISTS settlement_metrics_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS settlement_tie_break_used boolean;

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_money_tie_break_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_money_tie_break_check CHECK (
    money_tie_break IS NULL OR money_tie_break IN (
      -- Historical V1 values.
      'performance',
      'ending_mcap',
      'token_address',
      -- Battle Points V2 values.
      'battle_points',
      'mcap_component',
      'holder_component',
      'volume_component'
    )
  );

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_settlement_scoring_version_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_settlement_scoring_version_check CHECK (
    settlement_scoring_version IS NULL OR settlement_scoring_version IN ('mcap_pct_change', 'battle_points_v2')
  );

ALTER TABLE public.arena_battles
  DROP CONSTRAINT IF EXISTS arena_battles_battle_points_range_check;
ALTER TABLE public.arena_battles
  ADD CONSTRAINT arena_battles_battle_points_range_check CHECK (
    (challenger_battle_points IS NULL OR (challenger_battle_points >= 0 AND challenger_battle_points <= 100))
    AND (defender_battle_points IS NULL OR (defender_battle_points >= 0 AND defender_battle_points <= 100))
  );

COMMIT;
