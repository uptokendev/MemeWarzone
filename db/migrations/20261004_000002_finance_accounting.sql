BEGIN;

-- Command Center accounting (founder decisions 2026-10-04): costs entered in the dashboard, monthly
-- close, tax reserve, exports and distribution proposals. Default currency USD.
-- RLS on, no policies: only the API (table owner) reads and writes. Every write goes through
-- frontend/api/admin/financeAccounting.js, which logs it to finance_audit_log in the same transaction.
-- Idempotent: safe to run twice.

-- One row per cost entered. amount + currency is what was paid; amount_usd is fixed at entry with the
-- rate that was used (fx_rate = USD per 1 unit of currency, fx_source says where it came from).
-- eur_usd_rate (USD per 1 EUR, ECB reference rate) is stored for every row so exports can show EUR.
-- Recurring costs are one row: monthly / yearly occurrences are expanded when read, from incurred_on
-- until recurring_until (or open ended). Closed months keep their own frozen copy in the close snapshot.
CREATE TABLE IF NOT EXISTS public.finance_costs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  incurred_on      date NOT NULL,
  category         text NOT NULL,
  vendor           text NOT NULL,
  description      text NOT NULL DEFAULT '',
  amount           numeric(38, 18) NOT NULL,
  currency         text NOT NULL,
  amount_usd       numeric(24, 6) NOT NULL,
  fx_rate          numeric(30, 12) NOT NULL,
  fx_source        text NOT NULL,
  fx_at            timestamptz NULL,
  eur_usd_rate     numeric(20, 10) NULL,
  eur_usd_date     date NULL,
  recurring        text NOT NULL DEFAULT 'none',
  recurring_until  date NULL,
  attachment_url   text NULL,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_by       text NULL,
  deleted_at       timestamptz NULL,
  CONSTRAINT finance_costs_category_chk CHECK (category IN ('servers', 'rpc_infra', 'salaries_contractors', 'marketing', 'legal_accounting', 'tools_software', 'other')),
  CONSTRAINT finance_costs_currency_chk CHECK (currency IN ('USD', 'EUR', 'SOL', 'BNB', 'ETH')),
  CONSTRAINT finance_costs_recurring_chk CHECK (recurring IN ('none', 'monthly', 'yearly')),
  CONSTRAINT finance_costs_amount_chk CHECK (amount > 0),
  CONSTRAINT finance_costs_amount_usd_chk CHECK (amount_usd >= 0),
  CONSTRAINT finance_costs_fx_rate_chk CHECK (fx_rate > 0),
  CONSTRAINT finance_costs_eur_rate_chk CHECK (eur_usd_rate IS NULL OR eur_usd_rate > 0),
  CONSTRAINT finance_costs_vendor_len CHECK (char_length(vendor) BETWEEN 1 AND 120),
  CONSTRAINT finance_costs_description_len CHECK (char_length(description) <= 500),
  CONSTRAINT finance_costs_fx_source_len CHECK (char_length(fx_source) BETWEEN 1 AND 300),
  CONSTRAINT finance_costs_attachment_chk CHECK (attachment_url IS NULL OR (char_length(attachment_url) <= 500 AND attachment_url ~ '^https://')),
  CONSTRAINT finance_costs_recurring_until_chk CHECK (recurring_until IS NULL OR (recurring <> 'none' AND recurring_until >= incurred_on))
);

CREATE INDEX IF NOT EXISTS finance_costs_incurred_idx ON public.finance_costs (incurred_on) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS finance_costs_recurring_idx ON public.finance_costs (recurring) WHERE deleted_at IS NULL AND recurring <> 'none';

-- Who changed what, with the row before and after. Written in the same transaction as the change.
CREATE TABLE IF NOT EXISTS public.finance_audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_id     text NULL,
  actor_email  text NOT NULL,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text NULL,
  before       jsonb NULL,
  after        jsonb NULL,
  CONSTRAINT finance_audit_log_action_chk CHECK (action IN ('cost.create', 'cost.update', 'cost.delete', 'close.close', 'close.reopen', 'settings.tax_reserve_rules', 'settings.distribution')),
  CONSTRAINT finance_audit_log_entity_chk CHECK (entity_type IN ('finance_cost', 'finance_month_close', 'finance_settings'))
);

CREATE INDEX IF NOT EXISTS finance_audit_log_entity_idx ON public.finance_audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS finance_audit_log_time_idx ON public.finance_audit_log (occurred_at DESC);

-- Monthly close. month is the first day of the month. A closed month is read from snapshot and never
-- recomputed. Reopening keeps the last snapshot for reference and is logged; the month then reads live.
CREATE TABLE IF NOT EXISTS public.finance_month_close (
  month        date PRIMARY KEY,
  status       text NOT NULL DEFAULT 'open',
  snapshot     jsonb NULL,
  closed_by    text NULL,
  closed_at    timestamptz NULL,
  reopened_by  text NULL,
  reopened_at  timestamptz NULL,
  reopen_reason text NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_month_close_first_day CHECK (extract(day FROM month) = 1),
  CONSTRAINT finance_month_close_status_chk CHECK (status IN ('open', 'closed')),
  CONSTRAINT finance_month_close_snapshot_chk CHECK (status <> 'closed' OR (snapshot IS NOT NULL AND closed_by IS NOT NULL AND closed_at IS NOT NULL)),
  CONSTRAINT finance_month_close_reason_len CHECK (reopen_reason IS NULL OR char_length(reopen_reason) <= 500)
);

-- One settings row (id = 1). NULL means "use the defaults in code":
--   tax_reserve_rules: bracket list (default: Dutch vennootschapsbelasting brackets, labelled on the
--                      page as default rates to confirm with a tax adviser)
--   distribution:      shareholder shares (names, bps, payout addresses), treasury buffer, Safe addresses
CREATE TABLE IF NOT EXISTS public.finance_settings (
  id                 smallint PRIMARY KEY DEFAULT 1,
  tax_reserve_rules  jsonb NULL,
  distribution       jsonb NULL,
  updated_by         text NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_settings_single_row CHECK (id = 1)
);

ALTER TABLE public.finance_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_month_close ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_settings ENABLE ROW LEVEL SECURITY;

COMMIT;
