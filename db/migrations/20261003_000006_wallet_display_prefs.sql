BEGIN;

-- Portfolio display settings (founder 2026-10-03): per wallet, which holdings the Command Center and
-- the public profile list. prefs = { "hideNativeAndStables": bool, "hideSmall": bool }. A missing key
-- means off (show everything). Total value always counts every holding; only the list is filtered.
-- wallet_key: EVM lowercased, Solana base58. RLS on, no policies: only the API (table owner) reads and writes.
CREATE TABLE IF NOT EXISTS public.wallet_display_prefs (
  wallet_key  text PRIMARY KEY,
  prefs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_display_prefs_wallet_len CHECK (char_length(wallet_key) BETWEEN 32 AND 64)
);

ALTER TABLE public.wallet_display_prefs ENABLE ROW LEVEL SECURITY;

COMMIT;
