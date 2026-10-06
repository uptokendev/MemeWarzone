BEGIN;

-- Customer VAT evidence for the finance VAT reserve and the quarterly VAT return figures
-- (frontend/api/lib/financeVat.js, Tax page in the Command Center).
--
-- Only customers we actually know are covered: sponsors (sponsor_profiles, paid through event
-- sponsorships) and Home placement buyers (sponsorship_applications). An admin records what the
-- customer gave; nothing is collected from app users. Stored, and why:
--   customer_type, country      place of supply (art. 44 / 45 / 58 Directive 2006/112/EC)
--   vat_id, vies_status/name    reverse charge needs a VAT number checked in VIES (art. 18(1)
--                               Reg. 282/2011); the VIES name is the proof of that check. The VIES
--                               address is not stored.
--   business_number             business status outside the EU (art. 18(3))
--   evidence                    location items for a consumer (art. 24b(d), 24f): kind + country
--                               + a short note only. No raw IP address, no bank number.
--   note                        free text for the admin
-- Retention: Dutch bookkeeping keeps VAT records 7 years (10 for OSS records); delete a row with
-- the DELETE route when it is no longer needed.
--
-- RLS on with no policies: only the API (table owner) reads and writes; anon and authenticated get
-- no access. Changes are logged in finance_audit_log (actions vat_customer.*).
--
-- Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS public.finance_vat_customers (
  subject_kind     text NOT NULL CHECK (subject_kind IN ('sponsor_profile', 'sponsorship_application')),
  subject_id       text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 40),
  customer_type    text NOT NULL CHECK (customer_type IN ('business', 'consumer')),
  country          char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  vat_id           text NULL CHECK (vat_id IS NULL OR vat_id ~ '^[A-Z0-9]{4,20}$'),
  business_number  text NULL CHECK (business_number IS NULL OR char_length(business_number) BETWEEN 1 AND 60),
  vies_status      text NOT NULL DEFAULT 'not_checked' CHECK (vies_status IN ('not_checked', 'valid', 'invalid', 'unavailable')),
  vies_name        text NULL CHECK (vies_name IS NULL OR char_length(vies_name) <= 200),
  vies_checked_at  timestamptz NULL,
  evidence         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) <= 6),
  note             text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  updated_by       text NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_kind, subject_id)
);

ALTER TABLE public.finance_vat_customers ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.finance_vat_customers FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.finance_vat_customers FROM authenticated;
  END IF;
END $$;

-- Audit log: allow the new actions and entity (a superset of the earlier lists).
ALTER TABLE public.finance_audit_log DROP CONSTRAINT IF EXISTS finance_audit_log_action_chk;
ALTER TABLE public.finance_audit_log ADD CONSTRAINT finance_audit_log_action_chk CHECK (action IN (
  'cost.create', 'cost.update', 'cost.delete', 'close.close', 'close.reopen', 'settings.tax_reserve_rules', 'settings.distribution',
  'settings.tax_rules', 'distribution.create', 'distribution.update',
  'account.create', 'account.update', 'movement.create', 'movement.update', 'movement.delete',
  'tax_item.create', 'tax_item.update', 'tax_item.delete', 'settings.entity',
  'vat_customer.update', 'vat_customer.delete'));
ALTER TABLE public.finance_audit_log DROP CONSTRAINT IF EXISTS finance_audit_log_entity_chk;
ALTER TABLE public.finance_audit_log ADD CONSTRAINT finance_audit_log_entity_chk CHECK (entity_type IN (
  'finance_cost', 'finance_month_close', 'finance_settings', 'finance_distribution',
  'finance_account', 'finance_treasury_movement', 'finance_tax_item', 'finance_vat_customer'));

COMMENT ON TABLE public.finance_vat_customers IS 'VAT evidence for known customers (sponsors, Home placement buyers): type, country, VIES-checked VAT number, location items. Admin-recorded. API only.';

COMMIT;
