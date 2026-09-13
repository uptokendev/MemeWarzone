BEGIN;

ALTER TABLE public.dashboard_members
  DROP CONSTRAINT IF EXISTS dashboard_members_status_chk;

ALTER TABLE public.dashboard_members
  ADD CONSTRAINT dashboard_members_status_chk CHECK (
    status IN ('invited', 'active', 'disabled', 'suspended', 'deleted')
  );

COMMIT;
