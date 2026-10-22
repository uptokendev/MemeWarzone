BEGIN;

-- Swap-widget partners on graduated gen-8 coins (founder, 2026-10-22). A partner earns 0.25% of the volume of a
-- graduated gen-8 MemeWarzone coin swap (BNB 56, Robinhood 4663) that came through its widget, out of
-- MemeWarzone's 0.50%. No partner share while the coin is bonding. The gen-8 fee itself never moves for this:
-- MemeWarzone's share keeps flowing hook -> MwzFeeSplitter -> ProtocolRevenueVault (Safe only). The partner is
-- paid from the chain's ImportFeeVault, out of MemeWarzone's own import share there, by the import payout worker
-- (realtime-indexer importCreatorFeesEvm.ts), before the daily sweep; when that share is short the amount waits
-- and the Safe can top the vault up (gen8_partner_topups).
--
-- 1. gen8_partner_fees: the ledger. One row per post-graduation gen-8 trade accrual (evm_gen8_fee_accruals) whose
--    landed transaction has the fingerprint the API recorded when it built that partner's widget swap
--    (import_swap_fingerprints). partner_raw = floor(curve_amount * 25 / 10000), never above the accrual's
--    protocol slice. Written by the indexer (realtime-indexer/src/evm/gen8PartnerFees.ts), ON CONFLICT DO NOTHING.
-- 2. gen8_partner_fee_cursors: the last accrual id the attribution checked per (chain, hook). It only moves past
--    a transaction whose RPC read succeeded: a failed read is retried, never recorded as "no partner".
-- 3. import_fee_transfers.gen8_raw: the part of a 'partner' payout that pays gen-8 dues (the rest pays the
--    partner's import share). 0 on every existing row and on every creator / protocol / consolidate row.
-- 4. gen8_partner_topups: Safe top-ups of an ImportFeeVault for gen-8 partner payouts. The founder inserts the
--    transaction hash and amount; the worker counts a row only once its receipt shows a Deposit of exactly that
--    amount into that vault and the transaction is not an import fee row.
--
-- RLS on, no policies: API and indexer only (same as the other import fee tables). Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS public.gen8_partner_fees (
  id             bigserial PRIMARY KEY,
  chain_id       integer NOT NULL CHECK (chain_id IN (56, 4663, 97, 46630)),
  hook_address   text NOT NULL CHECK (hook_address ~ '^0x[0-9a-f]{40}$'),
  accrual_id     bigint NOT NULL,
  tx_hash        text NOT NULL CHECK (char_length(tx_hash) BETWEEN 1 AND 120),
  log_index      integer NOT NULL CHECK (log_index >= 0),
  token_address  text NOT NULL CHECK (char_length(token_address) BETWEEN 1 AND 64),
  partner_id     text NOT NULL CHECK (char_length(partner_id) BETWEEN 1 AND 41),
  fingerprint    text NOT NULL CHECK (char_length(fingerprint) BETWEEN 16 AND 128),
  curve_amount   numeric(78, 0) NOT NULL CHECK (curve_amount > 0),
  partner_raw    numeric(78, 0) NOT NULL CHECK (partner_raw > 0),
  block_time     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, tx_hash, log_index),
  UNIQUE (accrual_id),
  FOREIGN KEY (chain_id, tx_hash, log_index) REFERENCES public.evm_gen8_fee_accruals (chain_id, tx_hash, log_index) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS gen8_partner_fees_partner_idx ON public.gen8_partner_fees (chain_id, partner_id);

CREATE TABLE IF NOT EXISTS public.gen8_partner_fee_cursors (
  chain_id        integer NOT NULL CHECK (chain_id IN (56, 4663, 97, 46630)),
  hook_address    text NOT NULL CHECK (hook_address ~ '^0x[0-9a-f]{40}$'),
  last_accrual_id bigint NOT NULL CHECK (last_accrual_id >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, hook_address)
);

-- The attribution scan: post-graduation trade accruals of one chain, in id order after the cursor.
CREATE INDEX IF NOT EXISTS evm_gen8_fee_accruals_post_trade_idx
  ON public.evm_gen8_fee_accruals (chain_id, id) WHERE kind = 'trade' AND phase = 'post';

ALTER TABLE public.import_fee_transfers ADD COLUMN IF NOT EXISTS gen8_raw numeric(78, 0) NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_fee_transfers_gen8_raw_check') THEN
    ALTER TABLE public.import_fee_transfers
      ADD CONSTRAINT import_fee_transfers_gen8_raw_check CHECK (gen8_raw >= 0 AND gen8_raw <= amount_raw AND (gen8_raw = 0 OR kind = 'partner'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS import_fee_transfers_partner_idx ON public.import_fee_transfers (chain_id, partner_id) WHERE kind = 'partner';

CREATE TABLE IF NOT EXISTS public.gen8_partner_topups (
  id           bigserial PRIMARY KEY,
  chain_id     integer NOT NULL CHECK (chain_id IN (56, 4663, 97, 46630)),
  vault        text NOT NULL CHECK (vault ~ '^0x[0-9a-f]{40}$'),
  tx_hash      text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  amount_raw   numeric(78, 0) NOT NULL CHECK (amount_raw > 0),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  note         text NULL CHECK (note IS NULL OR char_length(note) <= 200),
  error        text NULL CHECK (error IS NULL OR char_length(error) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now(),
  verified_at  timestamptz NULL,
  UNIQUE (chain_id, tx_hash)
);

ALTER TABLE public.gen8_partner_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gen8_partner_fee_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gen8_partner_topups ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.gen8_partner_fees, public.gen8_partner_fee_cursors, public.gen8_partner_topups FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.gen8_partner_fees, public.gen8_partner_fee_cursors, public.gen8_partner_topups FROM authenticated;
  END IF;
END $$;

COMMENT ON TABLE public.gen8_partner_fees IS 'Swap-widget partner share (0.25% of volume) of graduated gen-8 coin swaps built by the widget; paid from the ImportFeeVault out of MemeWarzone''s import share.';
COMMENT ON TABLE public.gen8_partner_fee_cursors IS 'Last gen-8 accrual id checked for partner attribution per chain and hook.';
COMMENT ON COLUMN public.import_fee_transfers.gen8_raw IS 'Part of a partner payout that pays gen-8 partner dues (gen8_partner_fees); the rest pays the import share.';
COMMENT ON TABLE public.gen8_partner_topups IS 'Safe top-ups of an ImportFeeVault for gen-8 partner payouts; counted once verified on chain.';

COMMIT;
