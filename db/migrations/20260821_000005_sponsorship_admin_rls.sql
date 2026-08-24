-- Sponsorship admin tables: browser roles may read public feed data only.
-- Mutations go through the MemeWarzone admin API (service_role).

BEGIN;

ALTER TABLE IF EXISTS public.sponsorship_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sponsored_placements ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sponsorship_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sponsorship_packages ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsorship_applications FROM anon;
    REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsored_placements FROM anon;
    REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsorship_settings FROM anon;
    REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsorship_packages FROM anon;
    GRANT SELECT ON TABLE public.sponsored_placements TO anon;
    GRANT SELECT ON TABLE public.sponsorship_packages TO anon;
    GRANT SELECT ON TABLE public.sponsorship_settings TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsorship_applications FROM authenticated;
    REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsored_placements FROM authenticated;
    REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsorship_settings FROM authenticated;
    REVOKE INSERT, UPDATE, DELETE ON TABLE public.sponsorship_packages FROM authenticated;
    GRANT SELECT ON TABLE public.sponsored_placements TO authenticated;
    GRANT SELECT ON TABLE public.sponsorship_packages TO authenticated;
    GRANT SELECT ON TABLE public.sponsorship_settings TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sponsorship_applications TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sponsored_placements TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sponsorship_settings TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sponsorship_packages TO service_role;
  END IF;
END
$$;

COMMIT;
