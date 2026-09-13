-- Security hardening for the Command Center final-Owner trigger.
-- The function uses fully-qualified application relations, so it does not need a mutable search_path.

ALTER FUNCTION public.dashboard_members_preserve_last_owner()
  SET search_path = pg_catalog;
