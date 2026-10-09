BEGIN;

-- Swap-widget partners (founder, 2026-10-09): a website that embeds the swap widget (first: CrypticPump)
-- shares in the 1% import fee: creator 50% / partner 25% / MemeWarzone 25% (bps of the fee, per partner
-- row). The fee goes to our usual receiver; the swap is attributed to the partner by a fingerprint the
-- API records when it builds that partner's swap (import_swap_fingerprints): EVM = keccak(to, data,
-- value) of the built transaction, Solana = the wallet + the Jupiter instruction's data (wallets add
-- their own instructions around it but leave it unchanged). Adding a partner is one row; no contract,
-- no deploy. Fallback: a Solana partner row with fee_account set uses its own WSOL fee account (owned by
-- our collector) instead of fingerprints.
--
-- 1. import_fee_partners: one row per partner per chain (payout wallet + split). fee_account / start_block
--    only for the fallback of an own receiver (Solana WSOL account owned by the collector).
--    import_swap_fingerprints: the partner swaps the API built.
-- 2. finance_import_swap_fees.partner_id / partner_raw: the partner's part of a fee row. Revenue counts
--    fee_raw - creator_raw - partner_raw.
-- 3. import_fee_transfers: kinds 'partner' (payout to the partner's wallet) and 'consolidate' (a
--    partner receiver's balance moved into the default collector account; changes no one's due).
-- 4. import_auto_imports: coins that earned creator fees but had no MemeWarzone page; MemeWarzone imports
--    them itself (same pipeline as a user import) so the creator can claim. One row per coin with the
--    last attempt, so a coin that is still bonding or failed the scan is retried at most every 6 hours.
--
-- RLS on, no policies: API and indexer only. Idempotent.

CREATE TABLE IF NOT EXISTS public.import_fee_partners (
  id             text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  chain_id       integer NOT NULL CHECK (chain_id IN (101, 56, 4663, 97, 46630, 6281971)),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  fee_account    text NULL CHECK (fee_account IS NULL OR char_length(fee_account) BETWEEN 1 AND 64),
  payout_wallet  text NOT NULL CHECK (char_length(payout_wallet) BETWEEN 1 AND 64),
  creator_bps    integer NOT NULL DEFAULT 5000 CHECK (creator_bps BETWEEN 0 AND 10000),
  partner_bps    integer NOT NULL DEFAULT 2500 CHECK (partner_bps BETWEEN 0 AND 10000),
  start_block    bigint NULL CHECK (start_block IS NULL OR start_block > 0),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, chain_id),
  UNIQUE (chain_id, fee_account),
  CHECK (creator_bps + partner_bps <= 10000)
);

-- Earlier draft of this file had fee_account NOT NULL (applied on staging only).
ALTER TABLE public.import_fee_partners ALTER COLUMN fee_account DROP NOT NULL;

-- One row per partner swap the API built: the fingerprint the ledger matches against the fee row.
CREATE TABLE IF NOT EXISTS public.import_swap_fingerprints (
  fingerprint    text PRIMARY KEY CHECK (char_length(fingerprint) BETWEEN 16 AND 128),
  chain_id       integer NOT NULL CHECK (chain_id IN (101, 56, 4663, 97, 46630, 6281971)),
  partner_id     text NOT NULL CHECK (char_length(partner_id) BETWEEN 1 AND 41),
  wallet         text NULL CHECK (wallet IS NULL OR char_length(wallet) BETWEEN 1 AND 64),
  token_address  text NULL CHECK (token_address IS NULL OR char_length(token_address) BETWEEN 1 AND 64),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_swap_fingerprints_created_idx ON public.import_swap_fingerprints (created_at);

ALTER TABLE public.finance_import_swap_fees ADD COLUMN IF NOT EXISTS partner_id text NULL;
ALTER TABLE public.finance_import_swap_fees ADD COLUMN IF NOT EXISTS partner_raw numeric(78, 0) NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_import_swap_fees_split_check') THEN
    ALTER TABLE public.finance_import_swap_fees
      ADD CONSTRAINT finance_import_swap_fees_split_check CHECK (partner_raw >= 0 AND creator_raw + partner_raw <= fee_raw);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS finance_import_swap_fees_partner_idx ON public.finance_import_swap_fees (partner_id) WHERE partner_id IS NOT NULL;

ALTER TABLE public.import_fee_transfers DROP CONSTRAINT IF EXISTS import_fee_transfers_kind_check;
ALTER TABLE public.import_fee_transfers
  ADD CONSTRAINT import_fee_transfers_kind_check CHECK (kind IN ('creator', 'protocol', 'partner', 'consolidate'));
ALTER TABLE public.import_fee_transfers ADD COLUMN IF NOT EXISTS partner_id text NULL;

CREATE TABLE IF NOT EXISTS public.import_auto_imports (
  chain_id        integer NOT NULL CHECK (chain_id IN (101, 56, 4663, 97, 46630, 6281971)),
  token_address   text NOT NULL CHECK (char_length(token_address) BETWEEN 1 AND 64),
  attempts        integer NOT NULL DEFAULT 0,
  outcome         text NULL CHECK (outcome IS NULL OR outcome IN ('imported', 'exists', 'refused', 'error')),
  error           text NULL CHECK (error IS NULL OR char_length(error) <= 500),
  last_attempt_at timestamptz NULL,
  PRIMARY KEY (chain_id, token_address)
);

ALTER TABLE public.import_fee_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_swap_fingerprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.import_auto_imports ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.import_fee_partners, public.import_auto_imports, public.import_swap_fingerprints FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.import_fee_partners, public.import_auto_imports, public.import_swap_fingerprints FROM authenticated;
  END IF;
END $$;

COMMENT ON TABLE public.import_fee_partners IS 'Swap-widget partners: their own fee receiver and the split of the fee (creator / partner / MemeWarzone).';
COMMENT ON TABLE public.import_auto_imports IS 'Coins MemeWarzone imported (or tried to) because they earned creator fees through the swap widget.';

COMMIT;
