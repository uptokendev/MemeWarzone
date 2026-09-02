-- Battle V2 Phase 3–5: structured live baselines, eligible volume audit, and points storage.
-- Additive only. Does not alter arena_battles V1 MCAP columns or settlement_version.

BEGIN;

CREATE TABLE IF NOT EXISTS public.arena_battle_metrics (
  battle_id text NOT NULL REFERENCES public.arena_battles(id) ON DELETE CASCADE,
  token_id text NOT NULL,
  side text NOT NULL,
  scoring_version text NOT NULL DEFAULT 'battle_points_v2',

  start_mcap_usd numeric,
  start_holders integer,
  start_liquidity_usd numeric,
  baseline_timestamp timestamptz,
  baseline_market_data_updated_at timestamptz,
  baseline_data_source text,
  baseline_healthy boolean,

  current_mcap_usd numeric,
  current_holders integer,
  current_liquidity_usd numeric,
  market_data_updated_at timestamptz,
  data_lag_seconds integer,
  data_source text,
  data_healthy boolean,

  eligible_battle_volume_usd numeric NOT NULL DEFAULT 0,
  volume_raw_usd numeric NOT NULL DEFAULT 0,
  volume_excluded_usd numeric NOT NULL DEFAULT 0,
  volume_capped_usd numeric NOT NULL DEFAULT 0,

  mcap_points numeric,
  holder_points numeric,
  volume_points numeric,
  battle_points numeric,

  metrics_updated_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),

  PRIMARY KEY (battle_id, side),
  CONSTRAINT arena_battle_metrics_side_check CHECK (side IN ('left', 'right')),
  CONSTRAINT arena_battle_metrics_scoring_check CHECK (scoring_version <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS arena_battle_metrics_battle_token_uidx
  ON public.arena_battle_metrics (battle_id, token_id);

CREATE INDEX IF NOT EXISTS arena_battle_metrics_battle_idx
  ON public.arena_battle_metrics (battle_id);

CREATE TABLE IF NOT EXISTS public.arena_battle_volume_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  battle_id text NOT NULL REFERENCES public.arena_battles(id) ON DELETE CASCADE,
  token_id text NOT NULL,
  side text NOT NULL,
  wallet text,
  cluster_id text,
  tx_hash text,
  log_index integer,
  block_time timestamptz,
  native_amount numeric,
  usd_amount numeric,
  side_kind text,
  source text,
  included boolean NOT NULL,
  exclude_reason text,
  raw_cluster_usd numeric,
  counted_cluster_usd numeric,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_battle_volume_audit_side_check CHECK (side IN ('left', 'right'))
);

CREATE INDEX IF NOT EXISTS arena_battle_volume_audit_battle_idx
  ON public.arena_battle_volume_audit (battle_id, token_id, included);

CREATE UNIQUE INDEX IF NOT EXISTS arena_battle_volume_audit_trade_uidx
  ON public.arena_battle_volume_audit (battle_id, token_id, tx_hash, log_index)
  WHERE tx_hash IS NOT NULL;

DROP TRIGGER IF EXISTS set_arena_battle_metrics_updated_at ON public.arena_battle_metrics;
CREATE TRIGGER set_arena_battle_metrics_updated_at
BEFORE UPDATE ON public.arena_battle_metrics
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_battle_metrics FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_battle_volume_audit FROM anon, authenticated;

GRANT SELECT ON TABLE public.arena_battle_metrics TO anon, authenticated;
GRANT SELECT ON TABLE public.arena_battle_volume_audit TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_battle_metrics TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_battle_volume_audit TO service_role;

ALTER TABLE public.arena_battle_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_battle_volume_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS arena_battle_metrics_public_read ON public.arena_battle_metrics;
CREATE POLICY arena_battle_metrics_public_read ON public.arena_battle_metrics FOR SELECT USING (true);

DROP POLICY IF EXISTS arena_battle_volume_audit_public_read ON public.arena_battle_volume_audit;
CREATE POLICY arena_battle_volume_audit_public_read ON public.arena_battle_volume_audit FOR SELECT USING (true);

COMMIT;
