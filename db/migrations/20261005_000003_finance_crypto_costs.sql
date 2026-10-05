BEGIN;

-- Crypto-paid costs, token assets and the entity status (founder 2026-10-05).
--
-- 1. Movement kind 'crypto_payment': a cost paid from one of our wallets on the chain (for example a
--    support buy of a platform coin by the operator wallet, booked as marketing). It links to a
--    finance_costs row like a bank payment does. The crypto leaves at its FIFO cost; the cost's EUR
--    value is the market value at the time; the difference is a realized gain or loss.
-- 2. Tokens other than the core assets (any SPL or ERC-20, e.g. K88) may be a leg of a movement: the
--    leg keeps the token's symbol and the token's mint / contract address in asset_address. The core
--    whitelist (EUR, USD, SOL, BNB, ETH, USDC, USDT) stays for fiat and the major coins; at most one
--    leg of a movement is a token, the fee is always a core asset.
-- 3. finance_settings.entity: {"status": "in_formation" | "registered", "registeredOn": "YYYY-MM-DD" | null}.
--    NULL means in formation. A label only: no calculation reads it.
--
-- RLS unchanged (on, no policies): only the API (table owner) reads and writes, through
-- frontend/api/admin/financeAccounting.js, which checks finance.view / finance.manage and logs every
-- write to finance_audit_log in the same transaction. Nothing here moves funds.
--
-- Idempotent: safe to run twice. Needs 20261005_000001_finance_distributions.sql AND
-- 20261005_000002_finance_treasury_tax.sql first: it stops with an error naming the missing file.

DO $$
BEGIN
  IF to_regclass('public.finance_costs') IS NULL OR to_regclass('public.finance_audit_log') IS NULL OR to_regclass('public.finance_settings') IS NULL THEN
    RAISE EXCEPTION 'Apply db/migrations/20261004_000002_finance_accounting.sql first, then 20261005_000001_finance_distributions.sql and 20261005_000002_finance_treasury_tax.sql.';
  END IF;
  IF to_regclass('public.finance_distributions') IS NULL THEN
    RAISE EXCEPTION 'Apply db/migrations/20261005_000001_finance_distributions.sql first, then 20261005_000002_finance_treasury_tax.sql, then this file.';
  END IF;
  IF to_regclass('public.finance_treasury_movements') IS NULL OR to_regclass('public.finance_accounts') IS NULL OR to_regclass('public.finance_tax_items') IS NULL THEN
    RAISE EXCEPTION 'Apply db/migrations/20261005_000002_finance_treasury_tax.sql first, then this file.';
  END IF;
END $$;

-- Token address for the one token leg of a movement (Solana mint or EVM contract).
ALTER TABLE public.finance_treasury_movements ADD COLUMN IF NOT EXISTS asset_address text NULL;

ALTER TABLE public.finance_treasury_movements DROP CONSTRAINT IF EXISTS finance_treasury_movements_kind_chk;
ALTER TABLE public.finance_treasury_movements ADD CONSTRAINT finance_treasury_movements_kind_chk CHECK (kind IN (
  'opening_balance', 'transfer_internal', 'conversion', 'bank_payment', 'bank_receipt', 'owner_contribution', 'owner_loan', 'fee', 'crypto_payment'));

ALTER TABLE public.finance_treasury_movements DROP CONSTRAINT IF EXISTS finance_treasury_movements_cost_chk;
ALTER TABLE public.finance_treasury_movements ADD CONSTRAINT finance_treasury_movements_cost_chk CHECK (
  (cost_id IS NULL OR kind IN ('bank_payment', 'crypto_payment')) AND (kind <> 'crypto_payment' OR cost_id IS NOT NULL));

-- A crypto payment leaves one account (a wallet; the API checks the account kind) with an out leg in
-- crypto or a token, and has no in leg.
ALTER TABLE public.finance_treasury_movements DROP CONSTRAINT IF EXISTS finance_treasury_movements_crypto_payment_chk;
ALTER TABLE public.finance_treasury_movements ADD CONSTRAINT finance_treasury_movements_crypto_payment_chk CHECK (
  kind <> 'crypto_payment' OR (from_account_id IS NOT NULL AND to_account_id IS NULL AND asset_out IS NOT NULL AND asset_in IS NULL AND asset_out NOT IN ('EUR', 'USD')));

-- Core assets stay whitelisted. A leg outside the whitelist is a token: a symbol (letters, digits and
-- . _ $ -, up to 20) with asset_address set. Exactly one token leg when asset_address is set, none
-- otherwise. The fee is always a core asset.
ALTER TABLE public.finance_treasury_movements DROP CONSTRAINT IF EXISTS finance_treasury_movements_assets_chk;
ALTER TABLE public.finance_treasury_movements ADD CONSTRAINT finance_treasury_movements_assets_chk CHECK (
  (fee_asset IS NULL OR fee_asset IN ('EUR', 'USD', 'SOL', 'BNB', 'ETH', 'USDC', 'USDT')) AND
  (asset_out IS NULL OR asset_out IN ('EUR', 'USD', 'SOL', 'BNB', 'ETH', 'USDC', 'USDT') OR asset_out ~ '^[A-Za-z0-9][A-Za-z0-9._$-]{0,19}$') AND
  (asset_in IS NULL OR asset_in IN ('EUR', 'USD', 'SOL', 'BNB', 'ETH', 'USDC', 'USDT') OR asset_in ~ '^[A-Za-z0-9][A-Za-z0-9._$-]{0,19}$') AND
  ((CASE WHEN asset_out IS NOT NULL AND asset_out NOT IN ('EUR', 'USD', 'SOL', 'BNB', 'ETH', 'USDC', 'USDT') THEN 1 ELSE 0 END)
   + (CASE WHEN asset_in IS NOT NULL AND asset_in NOT IN ('EUR', 'USD', 'SOL', 'BNB', 'ETH', 'USDC', 'USDT') THEN 1 ELSE 0 END))
   = (CASE WHEN asset_address IS NULL THEN 0 ELSE 1 END));

ALTER TABLE public.finance_treasury_movements DROP CONSTRAINT IF EXISTS finance_treasury_movements_asset_address_chk;
ALTER TABLE public.finance_treasury_movements ADD CONSTRAINT finance_treasury_movements_asset_address_chk CHECK (
  asset_address IS NULL OR asset_address ~ '^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$');

-- Entity status (label only).
ALTER TABLE public.finance_settings ADD COLUMN IF NOT EXISTS entity jsonb NULL;

-- Audit log: allow the new setting (a superset of the earlier lists). Booking a crypto cost writes
-- cost.create and movement.create, which are allowed already.
ALTER TABLE public.finance_audit_log DROP CONSTRAINT IF EXISTS finance_audit_log_action_chk;
ALTER TABLE public.finance_audit_log ADD CONSTRAINT finance_audit_log_action_chk CHECK (action IN (
  'cost.create', 'cost.update', 'cost.delete', 'close.close', 'close.reopen', 'settings.tax_reserve_rules', 'settings.distribution',
  'settings.tax_rules', 'distribution.create', 'distribution.update',
  'account.create', 'account.update', 'movement.create', 'movement.update', 'movement.delete',
  'tax_item.create', 'tax_item.update', 'tax_item.delete', 'settings.entity'));
ALTER TABLE public.finance_audit_log DROP CONSTRAINT IF EXISTS finance_audit_log_entity_chk;
ALTER TABLE public.finance_audit_log ADD CONSTRAINT finance_audit_log_entity_chk CHECK (entity_type IN (
  'finance_cost', 'finance_month_close', 'finance_settings', 'finance_distribution',
  'finance_account', 'finance_treasury_movement', 'finance_tax_item'));

COMMIT;
