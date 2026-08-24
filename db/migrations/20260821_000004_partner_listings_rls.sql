-- Partner listings are written only through the authenticated API.

BEGIN;

ALTER TABLE IF EXISTS public.campaign_partner_listings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE INSERT, UPDATE, DELETE ON TABLE public.campaign_partner_listings FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE INSERT, UPDATE, DELETE ON TABLE public.campaign_partner_listings FROM authenticated;
  END IF;
END
$$;

COMMIT;
