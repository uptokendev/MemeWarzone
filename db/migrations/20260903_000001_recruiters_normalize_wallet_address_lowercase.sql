BEGIN;

-- Recruiter identity is multichain, but the legacy recruiters.wallet_address
-- column is constrained to lowercase. Solana public keys are case-sensitive and
-- remain canonical in metadata.signup.solanaWalletAddress. Normalize only the
-- legacy storage column before its lowercase CHECK constraint is evaluated.
CREATE OR REPLACE FUNCTION public.normalize_recruiter_wallet_address_lowercase()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.wallet_address := lower(NEW.wallet_address);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS recruiters_normalize_wallet_address_lowercase ON public.recruiters;

CREATE TRIGGER recruiters_normalize_wallet_address_lowercase
BEFORE INSERT OR UPDATE OF wallet_address ON public.recruiters
FOR EACH ROW
EXECUTE FUNCTION public.normalize_recruiter_wallet_address_lowercase();

COMMIT;
