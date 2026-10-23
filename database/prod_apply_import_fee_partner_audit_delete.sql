BEGIN;

-- Paste into the Supabase SQL editor (production). Same statements as db/migrations/20261023_000010_import_fee_partner_audit_delete.sql.
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

-- Read-only check: the constraint should list create, update and delete.
SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
 WHERE conrelid = 'public.import_fee_partner_audit'::regclass AND contype = 'c';
