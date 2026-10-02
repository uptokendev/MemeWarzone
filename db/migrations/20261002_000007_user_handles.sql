BEGIN;

-- Usernames (founder, 2026-10-02). One unique @username per wallet across all chains, used for
-- @tags in posts. wallet_key is the wallet as the feed stores it: EVM lowercased, Solana base58 as-is.
-- 3-20 characters, a-z 0-9 underscore, unique case-insensitive. changed_at drives the 30-day change
-- cooldown (checked by the API). RLS on, no policies: only the API (table owner) reads and writes.
CREATE TABLE IF NOT EXISTS public.user_handles (
  wallet_key  text PRIMARY KEY,
  handle      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_handles_handle_format CHECK (handle ~ '^[A-Za-z0-9_]{3,20}$'),
  CONSTRAINT user_handles_wallet_key_len CHECK (char_length(wallet_key) BETWEEN 32 AND 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS user_handles_handle_lower_uidx ON public.user_handles (lower(handle));

ALTER TABLE public.user_handles ENABLE ROW LEVEL SECURITY;

COMMIT;
