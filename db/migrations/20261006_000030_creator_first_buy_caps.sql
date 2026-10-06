BEGIN;

-- Creator first-buy caps (founder, 2026-10-06). Every creator's first buy at launch may take up to
-- the default share of supply (20%). A row here gives one wallet its own share (max_bps), up to the
-- ceiling (50%): big launches that bring traffic. Default and ceiling are API settings
-- (DBC_FIRST_BUY_DEFAULT_BPS / DBC_FIRST_BUY_PARTNER_MAX_BPS); the API clamps every row to them, so the
-- table only bounds max_bps to a real share.
-- Read by POST /api/dbc/create (authorize + quote-first-buy) for Solana DBC coins (chain 101). The
-- chain_id key leaves room for BNB / Robinhood once a factory can take a per-creator cap (their
-- deployed gen-6 contracts fix it at 10%). Solana wallets are stored as given (base58), EVM lowercase.
-- Idempotent. RLS on, no policies: only the API (table owner) reads and writes.
CREATE TABLE IF NOT EXISTS public.creator_first_buy_caps (
  chain_id    integer NOT NULL,
  wallet      text NOT NULL CHECK (char_length(wallet) BETWEEN 32 AND 64),
  max_bps     integer NOT NULL CHECK (max_bps > 0 AND max_bps <= 10000),
  note        text CHECK (note IS NULL OR char_length(note) <= 300),
  granted_by  text NOT NULL CHECK (char_length(btrim(granted_by)) BETWEEN 2 AND 100),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, wallet)
);

ALTER TABLE public.creator_first_buy_caps ENABLE ROW LEVEL SECURITY;

COMMIT;
