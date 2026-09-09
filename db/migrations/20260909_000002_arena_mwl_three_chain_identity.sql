-- Monthly Major War League three-chain identity hardening.
-- Scope: MWL only. This migration does not implement claims or change Quarterly Championship economics/runtime.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS arena_league_seasons_id_chain_uidx
  ON public.arena_league_seasons (id, chain_id);

CREATE OR REPLACE FUNCTION public.enforce_arena_mwl_monthly_identity()
RETURNS trigger AS $$
DECLARE
  expected_id text;
BEGIN
  -- Historical pre-monthly rows remain untouched. Current Monthly MWL rows are exact-chain authority.
  IF NEW.month IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.chain_id NOT IN (56, 97, 101, 4663, 46630) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MWL_CHAIN_UNSUPPORTED';
  END IF;
  IF NEW.month < 1 OR NEW.month > 12 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MWL_MONTH_INVALID';
  END IF;

  expected_id := format('mwl-%s-m%s-c%s', NEW.year, lpad(NEW.month::text, 2, '0'), NEW.chain_id);
  IF NEW.id <> expected_id OR COALESCE(NEW.mwl_epoch_key, '') <> expected_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MWL_SEASON_IDENTITY_MISMATCH',
      DETAIL = format('expected=%s actual=%s epoch=%s', expected_id, NEW.id, COALESCE(NEW.mwl_epoch_key, ''));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_arena_mwl_monthly_identity_row ON public.arena_league_seasons;
CREATE TRIGGER enforce_arena_mwl_monthly_identity_row
BEFORE INSERT OR UPDATE OF id, chain_id, year, month, mwl_epoch_key
ON public.arena_league_seasons
FOR EACH ROW EXECUTE FUNCTION public.enforce_arena_mwl_monthly_identity();

CREATE TABLE IF NOT EXISTS public.arena_mwl_finalizations (
  season_id text PRIMARY KEY,
  chain_id integer NOT NULL,
  year integer NOT NULL,
  month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  month_id text NOT NULL CHECK (month_id ~ '^[0-9]{6}$'),
  treasury_id text NOT NULL,
  treasury_config_key text NOT NULL,
  reserve_share_bps integer NOT NULL DEFAULT 6000 CHECK (reserve_share_bps = 6000),
  result_version text NOT NULL DEFAULT 'mwl_result_v1',
  entitlement_identity_version text NOT NULL DEFAULT 'mwl_entitlement_v1',
  finalized_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_mwl_finalizations_season_chain_fk
    FOREIGN KEY (season_id, chain_id)
    REFERENCES public.arena_league_seasons(id, chain_id)
    ON DELETE RESTRICT,
  CONSTRAINT arena_mwl_finalizations_chain_check
    CHECK (chain_id IN (56, 97, 101, 4663, 46630)),
  CONSTRAINT arena_mwl_finalizations_period_unique UNIQUE (chain_id, year, month)
);

CREATE TABLE IF NOT EXISTS public.arena_mwl_settlement_entitlements (
  entitlement_id text PRIMARY KEY,
  chain_id integer NOT NULL,
  season_id text NOT NULL REFERENCES public.arena_mwl_finalizations(season_id) ON DELETE RESTRICT,
  month_id text NOT NULL CHECK (month_id ~ '^[0-9]{6}$'),
  recipient text NOT NULL,
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0),
  settlement_version text NOT NULL,
  treasury_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT arena_mwl_settlement_entitlements_chain_check
    CHECK (chain_id IN (56, 97, 101, 4663, 46630)),
  CONSTRAINT arena_mwl_settlement_entitlements_identity_unique
    UNIQUE (chain_id, season_id, month_id, recipient, amount_raw, settlement_version)
);

CREATE OR REPLACE FUNCTION public.enforce_arena_mwl_entitlement_identity()
RETURNS trigger AS $$
DECLARE
  authority public.arena_mwl_finalizations%ROWTYPE;
  expected_key text;
BEGIN
  SELECT * INTO authority
    FROM public.arena_mwl_finalizations
   WHERE season_id = NEW.season_id;

  IF NOT FOUND
     OR authority.chain_id <> NEW.chain_id
     OR authority.month_id <> NEW.month_id
     OR authority.treasury_id <> NEW.treasury_id THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MWL_ENTITLEMENT_AUTHORITY_MISMATCH';
  END IF;

  expected_key := concat_ws(':', NEW.chain_id::text, NEW.season_id, NEW.month_id,
                            NEW.recipient, NEW.amount_raw::text, NEW.settlement_version);
  IF NEW.entitlement_id <> expected_key THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MWL_ENTITLEMENT_IDENTITY_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_arena_mwl_entitlement_identity_row ON public.arena_mwl_settlement_entitlements;
CREATE TRIGGER enforce_arena_mwl_entitlement_identity_row
BEFORE INSERT OR UPDATE ON public.arena_mwl_settlement_entitlements
FOR EACH ROW EXECUTE FUNCTION public.enforce_arena_mwl_entitlement_identity();

REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_mwl_finalizations FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.arena_mwl_settlement_entitlements FROM anon, authenticated;
GRANT SELECT ON TABLE public.arena_mwl_finalizations TO anon, authenticated;
GRANT SELECT ON TABLE public.arena_mwl_settlement_entitlements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_mwl_finalizations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.arena_mwl_settlement_entitlements TO service_role;

ALTER TABLE public.arena_mwl_finalizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.arena_mwl_settlement_entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS arena_mwl_finalizations_public_read ON public.arena_mwl_finalizations;
CREATE POLICY arena_mwl_finalizations_public_read ON public.arena_mwl_finalizations FOR SELECT USING (true);

DROP POLICY IF EXISTS arena_mwl_entitlements_authenticated_read ON public.arena_mwl_settlement_entitlements;
CREATE POLICY arena_mwl_entitlements_authenticated_read ON public.arena_mwl_settlement_entitlements FOR SELECT USING (true);

COMMIT;
