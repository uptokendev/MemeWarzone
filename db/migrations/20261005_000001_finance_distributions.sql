BEGIN;

-- Weekly distributions (founder 2026-10-05): record what was decided and paid per ISO week, so weeks
-- already paid come off the carry-over and the dividend tax obligations are tracked. Also stores the
-- researched tax rules (finance_settings.tax_rules; NULL = the defaults in code) and allows the new
-- audit actions. RLS on, no policies: only the API (table owner) reads and writes, through
-- frontend/api/admin/financeAccounting.js, which logs every write to finance_audit_log in the same
-- transaction. Nothing here moves funds: tx hashes are typed in after the multisig owners paid.
-- Idempotent: safe to run twice. Needs 20261004_000002_finance_accounting.sql first.

ALTER TABLE public.finance_settings ADD COLUMN IF NOT EXISTS tax_rules jsonb NULL;

-- One row per decided distribution. week = ISO week "2026-W40" (UTC days). Amounts are fixed when the
-- row is created from the weekly view and never recomputed. status: proposed -> approved -> paid, or
-- cancelled (not from paid). Approved and paid rows count as distributed for their week.
CREATE TABLE IF NOT EXISTS public.finance_distributions (
  id                           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  week                         text NOT NULL,
  status                       text NOT NULL DEFAULT 'proposed',
  available_on                 date NULL,
  usd_per_eur                  numeric(20, 10) NULL,
  total_gross_eur              numeric(24, 2) NOT NULL,
  total_withholding_eur        numeric(24, 2) NOT NULL DEFAULT 0,
  total_net_eur                numeric(24, 2) NOT NULL,
  total_gross_usd              numeric(24, 2) NULL,
  total_net_usd                numeric(24, 2) NULL,
  shares                       jsonb NOT NULL DEFAULT '[]'::jsonb,
  per_chain                    jsonb NOT NULL DEFAULT '[]'::jsonb,
  tx_hashes                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  checklist                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  dividend_tax_due_on          date NULL,
  dividend_tax_return_filed_on date NULL,
  dividend_tax_paid_on         date NULL,
  note                         text NOT NULL DEFAULT '',
  decided_by                   text NULL,
  decided_at                   timestamptz NULL,
  created_by                   text NOT NULL,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_by                   text NULL,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_distributions_week_chk CHECK (week ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$'),
  CONSTRAINT finance_distributions_status_chk CHECK (status IN ('proposed', 'approved', 'paid', 'cancelled')),
  CONSTRAINT finance_distributions_amounts_chk CHECK (total_gross_eur >= 0 AND total_withholding_eur >= 0 AND total_net_eur >= 0 AND total_withholding_eur <= total_gross_eur),
  CONSTRAINT finance_distributions_decided_chk CHECK (status IN ('proposed', 'cancelled') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT finance_distributions_note_len CHECK (char_length(note) <= 1000)
);

-- One live record per week (a cancelled one can be replaced).
CREATE UNIQUE INDEX IF NOT EXISTS finance_distributions_week_live_idx ON public.finance_distributions (week) WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS finance_distributions_status_idx ON public.finance_distributions (status, week DESC);

ALTER TABLE public.finance_distributions ENABLE ROW LEVEL SECURITY;

-- Audit log: allow the new actions and entity type.
ALTER TABLE public.finance_audit_log DROP CONSTRAINT IF EXISTS finance_audit_log_action_chk;
ALTER TABLE public.finance_audit_log ADD CONSTRAINT finance_audit_log_action_chk CHECK (action IN (
  'cost.create', 'cost.update', 'cost.delete', 'close.close', 'close.reopen', 'settings.tax_reserve_rules', 'settings.distribution',
  'settings.tax_rules', 'distribution.create', 'distribution.update'));
ALTER TABLE public.finance_audit_log DROP CONSTRAINT IF EXISTS finance_audit_log_entity_chk;
ALTER TABLE public.finance_audit_log ADD CONSTRAINT finance_audit_log_entity_chk CHECK (entity_type IN (
  'finance_cost', 'finance_month_close', 'finance_settings', 'finance_distribution'));

COMMIT;
