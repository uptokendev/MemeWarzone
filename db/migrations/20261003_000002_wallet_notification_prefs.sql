BEGIN;

-- Notification toggles (CO-5, founder 2026-10-03): per wallet, per category, bell and email.
-- prefs = { "<category>": { "bell": bool, "email": bool } } for categories battles, social, rewards,
-- coin. A missing key means on (today's behaviour). wallet_key: EVM lowercased, Solana base58.
-- RLS on, no policies: only the API (table owner) reads and writes.
CREATE TABLE IF NOT EXISTS public.wallet_notification_prefs (
  wallet_key  text PRIMARY KEY,
  prefs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_notification_prefs_wallet_len CHECK (char_length(wallet_key) BETWEEN 32 AND 64)
);

ALTER TABLE public.wallet_notification_prefs ENABLE ROW LEVEL SECURITY;

COMMIT;
