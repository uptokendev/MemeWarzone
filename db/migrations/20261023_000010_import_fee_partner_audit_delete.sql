BEGIN;

-- Command Center "Partners" (founder, 2026-10-23): a partner row with no history can be removed from the dashboard
-- (api/admin/importFeePartners.js DELETE). The removal is audited, so import_fee_partner_audit.action must allow 'delete'.
-- The original inline CHECK got a generated name, so it is found by what it checks instead of by name. Idempotent.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.import_fee_partner_audit'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%action%'
  LOOP
    EXECUTE format('ALTER TABLE public.import_fee_partner_audit DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.import_fee_partner_audit
    ADD CONSTRAINT import_fee_partner_audit_action_check CHECK (action IN ('create', 'update', 'delete'));
END $$;

COMMIT;
