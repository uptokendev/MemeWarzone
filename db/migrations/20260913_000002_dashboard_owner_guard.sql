-- Concurrency-safe invariant: Command Center must never lose its final active Owner.
-- The advisory transaction lock serializes all owner-removal paths across sessions.

BEGIN;

CREATE OR REPLACE FUNCTION public.dashboard_members_preserve_last_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  remaining_active_owners integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role <> 'owner' OR OLD.status <> 'active' THEN
      RETURN OLD;
    END IF;
  ELSE
    IF OLD.role <> 'owner' OR OLD.status <> 'active' THEN
      RETURN NEW;
    END IF;
    IF NEW.role = 'owner' AND NEW.status = 'active' THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Stable application-scoped lock key. The xact lock is released automatically
  -- on COMMIT/ROLLBACK and forces concurrent owner-removal attempts to serialize.
  PERFORM pg_advisory_xact_lock(hashtext('mwz.dashboard.active-owner-guard'));

  SELECT count(*)::integer
    INTO remaining_active_owners
    FROM public.dashboard_members
   WHERE role = 'owner'
     AND status = 'active'
     AND id <> OLD.id;

  IF remaining_active_owners < 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'MWZ_LAST_OWNER_PROTECTION',
      DETAIL = 'The final active Command Center Owner cannot be demoted, disabled, suspended, or deleted.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS dashboard_members_preserve_last_owner_trg
  ON public.dashboard_members;

CREATE TRIGGER dashboard_members_preserve_last_owner_trg
BEFORE UPDATE OF role, status OR DELETE
ON public.dashboard_members
FOR EACH ROW
EXECUTE FUNCTION public.dashboard_members_preserve_last_owner();

COMMIT;
