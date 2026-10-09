BEGIN;

-- Command Center "Partners" (founder, 2026-10-10): partners are added and changed from the dashboard
-- (api/admin/importFeePartners.js). Every create and change is logged here with who did it and the row
-- before and after; a payout wallet change redirects money, so it must be traceable.
-- RLS on, no policies: API only. Idempotent.

CREATE TABLE IF NOT EXISTS public.import_fee_partner_audit (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_id     text NULL,
  actor_email  text NOT NULL,
  action       text NOT NULL CHECK (action IN ('create', 'update')),
  partner_id   text NOT NULL,
  chain_id     integer NOT NULL,
  before       jsonb NULL,
  after        jsonb NULL
);
CREATE INDEX IF NOT EXISTS import_fee_partner_audit_partner_idx ON public.import_fee_partner_audit (partner_id, chain_id, occurred_at DESC);

ALTER TABLE public.import_fee_partner_audit ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.import_fee_partner_audit FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.import_fee_partner_audit FROM authenticated;
  END IF;
END $$;

COMMIT;
