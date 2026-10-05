BEGIN;

-- Treasury movements and tax items (founder 2026-10-05): the BV's own accounts (multisig, operator
-- wallets, exchange, bank), every movement between them and in or out of the BV that is not fee
-- revenue (transfers, conversions crypto -> EUR, costs paid from the bank, fiat received, owner money,
-- fees, opening balances), and every tax return, assessment, payment and refund. The books use them
-- for cash per account, realized gains and losses on crypto (FIFO by default) and to release the tax
-- reserve once tax is paid.
--
-- RLS on, no policies: only the API (table owner) reads and writes, through
-- frontend/api/admin/financeAccounting.js, which checks finance.view / finance.manage and logs every
-- write to finance_audit_log in the same transaction. Nothing here moves funds: rows are typed in (or
-- prefilled from a detected on-chain outflow) after the money moved.
--
-- Idempotent: safe to run twice. Needs 20261004_000002_finance_accounting.sql AND
-- 20261005_000001_finance_distributions.sql first (it stops with an error otherwise, because the
-- distributions migration resets the audit constraint to a shorter list).

DO $$
BEGIN
  IF to_regclass('public.finance_distributions') IS NULL THEN
    RAISE EXCEPTION 'Apply db/migrations/20261005_000001_finance_distributions.sql first.';
  END IF;
END $$;

-- Accounts the BV holds money in. Bank accounts keep only a masked IBAN (country code and the last 4).
CREATE TABLE IF NOT EXISTS public.finance_accounts (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text NOT NULL,
  kind          text NOT NULL,
  chain_id      integer NULL,
  address       text NULL,
  iban_masked   text NULL,
  currency      text NOT NULL,
  note          text NOT NULL DEFAULT '',
  archived_at   timestamptz NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_accounts_kind_chk CHECK (kind IN ('multisig', 'operator_wallet', 'exchange', 'bank', 'wallet_other')),
  CONSTRAINT finance_accounts_currency_chk CHECK (currency IN ('EUR', 'USD', 'SOL', 'BNB', 'ETH', 'USDC', 'USDT')),
  CONSTRAINT finance_accounts_chain_chk CHECK (chain_id IS NULL OR chain_id IN (101, 56, 4663)),
  CONSTRAINT finance_accounts_wallet_chk CHECK (kind NOT IN ('multisig', 'operator_wallet') OR (chain_id IS NOT NULL AND address IS NOT NULL)),
  CONSTRAINT finance_accounts_iban_chk CHECK (iban_masked IS NULL OR iban_masked ~ '^[A-Z]{2}[0-9*]{2}( \*{4})+ [0-9A-Z]{4}$'),
  CONSTRAINT finance_accounts_name_len CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT finance_accounts_note_len CHECK (char_length(note) <= 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_accounts_name_live_idx ON public.finance_accounts (lower(name)) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS finance_accounts_wallet_live_idx ON public.finance_accounts (chain_id, lower(address)) WHERE archived_at IS NULL AND address IS NOT NULL;
ALTER TABLE public.finance_accounts ENABLE ROW LEVEL SECURITY;

-- Movements. Out leg leaves from_account, in leg arrives at to_account, the fee is paid by from_account
-- (or to_account when there is no from). value_eur is the EUR value at the time (the proceeds of a
-- conversion, the cost basis of an opening balance), with its source. Soft delete keeps the history.
CREATE TABLE IF NOT EXISTS public.finance_treasury_movements (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at      timestamptz NOT NULL,
  kind             text NOT NULL,
  from_account_id  bigint NULL REFERENCES public.finance_accounts (id),
  to_account_id    bigint NULL REFERENCES public.finance_accounts (id),
  asset_out        text NULL,
  amount_out       numeric(38, 18) NULL,
  asset_in         text NULL,
  amount_in        numeric(38, 18) NULL,
  value_eur        numeric(24, 2) NOT NULL,
  value_source     text NOT NULL,
  usd_per_eur      numeric(20, 10) NULL,
  price_usd        numeric(30, 10) NULL,
  fee_asset        text NULL,
  fee_amount       numeric(38, 18) NULL,
  fee_eur          numeric(24, 2) NULL,
  fee_source       text NULL,
  cost_id          bigint NULL REFERENCES public.finance_costs (id),
  revenue_lane     text NULL,
  tx_hash          text NULL,
  reference        text NOT NULL DEFAULT '',
  note             text NOT NULL DEFAULT '',
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_by       text NULL,
  deleted_at       timestamptz NULL,
  CONSTRAINT finance_treasury_movements_kind_chk CHECK (kind IN ('opening_balance', 'transfer_internal', 'conversion', 'bank_payment', 'bank_receipt', 'owner_contribution', 'owner_loan', 'fee')),
  CONSTRAINT finance_treasury_movements_assets_chk CHECK (
    (asset_out IS NULL OR asset_out IN ('EUR', 'USD', 'SOL', 'BNB', 'ETH', 'USDC', 'USDT')) AND
    (asset_in IS NULL OR asset_in IN ('EUR', 'USD', 'SOL', 'BNB', 'ETH', 'USDC', 'USDT')) AND
    (fee_asset IS NULL OR fee_asset IN ('EUR', 'USD', 'SOL', 'BNB', 'ETH', 'USDC', 'USDT'))),
  CONSTRAINT finance_treasury_movements_legs_chk CHECK (
    (asset_out IS NULL) = (amount_out IS NULL) AND (asset_in IS NULL) = (amount_in IS NULL) AND (fee_asset IS NULL) = (fee_amount IS NULL) AND
    (amount_out IS NULL OR amount_out > 0) AND (amount_in IS NULL OR amount_in > 0) AND (fee_amount IS NULL OR fee_amount > 0) AND
    (asset_out IS NOT NULL OR asset_in IS NOT NULL)),
  CONSTRAINT finance_treasury_movements_accounts_chk CHECK (from_account_id IS NOT NULL OR to_account_id IS NOT NULL),
  CONSTRAINT finance_treasury_movements_value_chk CHECK (value_eur >= 0 AND (fee_eur IS NULL OR fee_eur >= 0)),
  CONSTRAINT finance_treasury_movements_lane_chk CHECK (revenue_lane IS NULL OR kind = 'bank_receipt'),
  CONSTRAINT finance_treasury_movements_cost_chk CHECK (cost_id IS NULL OR kind = 'bank_payment'),
  CONSTRAINT finance_treasury_movements_text_len CHECK (char_length(reference) <= 120 AND char_length(note) <= 1000 AND char_length(value_source) <= 300)
);
CREATE INDEX IF NOT EXISTS finance_treasury_movements_time_idx ON public.finance_treasury_movements (occurred_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS finance_treasury_movements_cost_idx ON public.finance_treasury_movements (cost_id) WHERE cost_id IS NOT NULL AND deleted_at IS NULL;
-- An on-chain transaction is recorded once per sending account.
CREATE UNIQUE INDEX IF NOT EXISTS finance_treasury_movements_tx_idx ON public.finance_treasury_movements (lower(tx_hash), coalesce(from_account_id, 0)) WHERE tx_hash IS NOT NULL AND deleted_at IS NULL;
ALTER TABLE public.finance_treasury_movements ENABLE ROW LEVEL SECURITY;

-- Tax returns, assessments, payments, refunds and notifications. period: '2026' (vpb),
-- '2026-Q3' or '2026-09' (vat), '2026-W40' (dividend_tax, the distribution's week).
CREATE TABLE IF NOT EXISTS public.finance_tax_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tax_type         text NOT NULL,
  period           text NOT NULL,
  kind             text NOT NULL,
  amount_eur       numeric(24, 2) NOT NULL DEFAULT 0,
  due_on           date NULL,
  done_on          date NOT NULL,
  account_id       bigint NULL REFERENCES public.finance_accounts (id),
  distribution_id  bigint NULL REFERENCES public.finance_distributions (id),
  reference        text NOT NULL DEFAULT '',
  note             text NOT NULL DEFAULT '',
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_by       text NULL,
  deleted_at       timestamptz NULL,
  CONSTRAINT finance_tax_items_type_chk CHECK (tax_type IN ('vpb', 'vat', 'dividend_tax')),
  CONSTRAINT finance_tax_items_kind_chk CHECK (kind IN ('provisional_assessment', 'return_filed', 'payment', 'refund', 'assessment_final', 'notification_filed')),
  CONSTRAINT finance_tax_items_period_chk CHECK (
    (tax_type = 'vpb' AND period ~ '^[0-9]{4}$') OR
    (tax_type = 'vat' AND period ~ '^[0-9]{4}-(Q[1-4]|0[1-9]|1[0-2])$') OR
    (tax_type = 'dividend_tax' AND period ~ '^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$')),
  CONSTRAINT finance_tax_items_notification_chk CHECK (kind <> 'notification_filed' OR tax_type = 'dividend_tax'),
  CONSTRAINT finance_tax_items_distribution_chk CHECK (distribution_id IS NULL OR tax_type = 'dividend_tax'),
  CONSTRAINT finance_tax_items_amount_chk CHECK (amount_eur >= 0),
  CONSTRAINT finance_tax_items_text_len CHECK (char_length(reference) <= 120 AND char_length(note) <= 1000)
);
CREATE INDEX IF NOT EXISTS finance_tax_items_period_idx ON public.finance_tax_items (tax_type, period) WHERE deleted_at IS NULL;
ALTER TABLE public.finance_tax_items ENABLE ROW LEVEL SECURITY;

-- Audit log: allow the new actions and entity types (a superset of the earlier lists).
ALTER TABLE public.finance_audit_log DROP CONSTRAINT IF EXISTS finance_audit_log_action_chk;
ALTER TABLE public.finance_audit_log ADD CONSTRAINT finance_audit_log_action_chk CHECK (action IN (
  'cost.create', 'cost.update', 'cost.delete', 'close.close', 'close.reopen', 'settings.tax_reserve_rules', 'settings.distribution',
  'settings.tax_rules', 'distribution.create', 'distribution.update',
  'account.create', 'account.update', 'movement.create', 'movement.update', 'movement.delete',
  'tax_item.create', 'tax_item.update', 'tax_item.delete'));
ALTER TABLE public.finance_audit_log DROP CONSTRAINT IF EXISTS finance_audit_log_entity_chk;
ALTER TABLE public.finance_audit_log ADD CONSTRAINT finance_audit_log_entity_chk CHECK (entity_type IN (
  'finance_cost', 'finance_month_close', 'finance_settings', 'finance_distribution',
  'finance_account', 'finance_treasury_movement', 'finance_tax_item'));

COMMIT;
