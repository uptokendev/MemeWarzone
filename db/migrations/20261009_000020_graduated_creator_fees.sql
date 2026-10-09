BEGIN;

-- Graduated MemeWarzone coins (founder, 2026-10-09): a coin that left its bonding curve trades through the
-- import route with the same 1% fee. The creator's half goes to the coin's creator (campaigns.creator_address)
-- straight away: no claim, no hold, no 90-day window. Imported coins keep the claim + hold + expiry rules.
--
-- import_creator_fees.payee_kind
--   import_owner      an imported coin: paid to the verified owner after the hold; expires after 90 days
--   campaign_creator  a graduated MemeWarzone coin: paid to the campaign's creator; never expires
-- expires_at is NULL for campaign_creator rows and set for import_owner rows.
--
-- Idempotent: safe to run twice. Existing rows are all import_owner.

ALTER TABLE public.import_creator_fees ADD COLUMN IF NOT EXISTS payee_kind text NOT NULL DEFAULT 'import_owner';
ALTER TABLE public.import_creator_fees ALTER COLUMN expires_at DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_creator_fees_payee_kind_check') THEN
    ALTER TABLE public.import_creator_fees
      ADD CONSTRAINT import_creator_fees_payee_kind_check CHECK (payee_kind IN ('import_owner', 'campaign_creator'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_creator_fees_expiry_kind_check') THEN
    ALTER TABLE public.import_creator_fees
      ADD CONSTRAINT import_creator_fees_expiry_kind_check CHECK ((payee_kind = 'campaign_creator') = (expires_at IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS import_creator_fees_payee_idx ON public.import_creator_fees (payee_kind, status);

COMMENT ON COLUMN public.import_creator_fees.payee_kind IS 'import_owner: imported coin (claim, hold, 90-day expiry). campaign_creator: graduated MemeWarzone coin, paid to campaigns.creator_address, never expires.';

COMMIT;
